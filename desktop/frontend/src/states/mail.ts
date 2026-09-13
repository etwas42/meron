import { observable } from '@legendapp/state'
import type { Folder, Message } from '../types'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { ui$, showToast, type BulkSelectionItem } from './ui'
import { accounts$, unifiedAccounts } from './accounts'
import { kanban$, getKanbanColumns, kanbanColumnKey } from './kanban'
import { columnSearchActive, loadKanbanColumn } from '../lib/kanbanData'
import { filterThreads, isRssAccount } from '../lib/threadActions'
import { isUnifiedStarred, unifiedFolderRole } from '../lib/unifiedFolders'
import { isLocalSendId } from './pendingSends'
import { CONVERSATION_PAGE_SIZE } from '../lib/pagination'
import { bareAddr, splitAddressList } from '../lib/address'
import { decrementFolderUnread, isDraftFolder, updateCachedFolderUnread } from './mailFolders'

// Mail data cache — the frontend view of the sidecar's `folders` and `messages`
// tables (threads are messages grouped by the sidecar). Ephemeral: repopulated
// from the sidecar on demand, never persisted on this side.
export const mail$ = observable({
  folders: [] as Folder[],
  // Real per-account folder lists, keyed by account id. `folders` above is the
  // view for the *selected* account (and is just a synthetic single inbox in the
  // unified view), so anything that needs a specific account's real folders —
  // e.g. the thread context menu's "Move to" in the unified inbox — reads here.
  foldersByAccount: {} as Record<string, Folder[]>,
  threads: [] as Message[],
  threadsCursor: '',
  threadAccountCursors: {} as Record<string, string>,
  threadsLoadingMore: false,
  // The view (`threadListViewKey`) whose threads are the ones in `threads`. An
  // empty list means "nothing here" only once this matches the view on screen:
  // before that the rows simply have not arrived, and saying the folder is empty
  // — at startup, or for the second or two a folder load takes — is wrong, then
  // wrong again when they land. Deliberately not a boolean set by `loadThreads`:
  // a selection or filter change repaints the list *before* the effect that
  // starts the load runs, and the client-side filter empties it on that very
  // render, so a flag set inside the load turns on a frame too late.
  threadsLoadedKey: '',
  messages: [] as Message[],
  // Opaque pagination cursor for older messages in the current thread; "" = no more.
  messagesCursor: '',
  // Loading flag for "Load earlier messages".
  messagesLoadingMore: false,
  // True while threadRead is in flight for a newly-selected thread. The reader
  // shows a spinner (instead of the previous thread's stale messages) when this
  // is set and the loaded messages don't yet belong to the active thread —
  // notably during the on-demand ancestor fetch, which adds a network round-trip.
  threadLoading: false,
  // Thread id whose last threadRead failed (backend timeout, network down).
  // The reader shows an error + retry instead of a silent blank pane; cleared
  // on the next load attempt for that thread.
  threadErrorId: '',
  readThreads: {} as Record<string, boolean>,
})

// Optimistic rollback for the keyed caches, key by key. Two reasons not to keep a
// whole `.get()` and restore that: Legend-State mutates a record's raw object in
// place when a *child* node is set (`kanban$.threads[key]`,
// `mail$.foldersByAccount[accountId]`), so the "previous state" keeps changing
// under us; and even a true whole-record snapshot would undo writes that landed
// for *other* keys while the mutation was in flight — a folder LIST for another
// account, another column's page. So each flow captures only the keys it is about
// to touch and puts back exactly those. Plain arrays (`mail$.threads`,
// `mail$.messages`, `mail$.folders`) are always replaced whole, so a bare `.get()`
// is already a snapshot there.
type KeyEntries<T> = [key: string, value: T | undefined][]

export function captureKeys<T>(record: Record<string, T>, keys: string[]): KeyEntries<T> {
  return keys.map((key) => [key, record[key]])
}

/** Kanban columns holding a card for this thread: all `updateKanbanThread` and
 * `removeKanbanThread` can touch, so all a rollback has to put back. */
export function kanbanKeysWithThread(threadId: string): string[] {
  return Object.entries(kanban$.threads.get())
    .filter(([, threads]) => threads.some((thread) => thread.thread_id === threadId))
    .map(([key]) => key)
}

// Re-read the list whose card stands for this thread after a change inside the
// conversation (a draft discarded, a message deleted) that the card's message
// count and Draft badge reflect. In the mail view that is the thread list. With
// a Kanban board up, `loadThreads` steps out — the list is off screen and
// reloads when the board closes — but the board's columns still show the card,
// and nothing else re-reads them: a reply sent from the board's pane left its
// card counting the draft the send had discarded until some later sync happened
// to touch that column.
//
// `columnKeys` are the columns that held the card, captured before any
// optimistic removal: a conversation whose only loaded message went is dropped
// from the columns ahead of the server round-trip, and looking the card up
// afterwards would find nothing to reload — yet the server may still hold older
// messages of the thread, which only a re-read of those columns brings back.
export async function reloadThreadCards(columnKeys: string[]) {
  const boardId = kanban$.activeBoardId.peek()
  if (!boardId) {
    await loadThreads(false)
    return
  }
  const keys = new Set(columnKeys)
  const query = kanban$.searchQuery.peek().trim()
  const scope = kanban$.searchScope.peek()
  await Promise.all(
    getKanbanColumns(boardId)
      .filter((column) => keys.has(kanbanColumnKey(column)))
      .map((column) => {
        const key = kanbanColumnKey(column)
        return loadKanbanColumn(column, false, columnSearchActive(key, query, scope) ? query : '')
      }),
  )
}

export function restoreAccountFolders(entries: KeyEntries<Folder[]>) {
  for (const [accountId, folders] of entries) {
    if (folders === undefined) mail$.foldersByAccount[accountId].delete()
    else mail$.foldersByAccount[accountId].set(folders)
  }
}

export function restoreKanbanColumns(threads: KeyEntries<Message[]>, unreadCounts: KeyEntries<number> = []) {
  for (const [key, columnThreads] of threads) {
    if (columnThreads === undefined) kanban$.threads[key].delete()
    else kanban$.threads[key].set(columnThreads)
  }
  for (const [key, count] of unreadCounts) {
    if (count === undefined) kanban$.unreadCounts[key].delete()
    else kanban$.unreadCounts[key].set(count)
  }
}

// The one record a flow does restore whole: `loadThreads` owns the entire cursor
// set for the query it is loading, and clears it outright, so there are no other
// keys to preserve.
function snapshotRecord<T>(record: Record<string, T>): Record<string, T> {
  return { ...record }
}

export function updateKanbanThread(threadId: string, update: (thread: Message) => Message) {
  const columns = kanban$.threads.get()
  const unreadCounts = kanban$.unreadCounts.get()
  const nextUnreadCounts = { ...unreadCounts }
  let changed = false
  const nextColumns = Object.fromEntries(
    Object.entries(columns).map(([key, threads]) => {
      let columnChanged = false
      const nextThreads = threads.map((thread) => {
        if (thread.thread_id !== threadId) return thread
        columnChanged = true
        const next = update(thread)
        const beforeUnread = thread.unread ? (thread.unread_count ?? 1) : 0
        const afterUnread = next.unread ? (next.unread_count ?? 1) : 0
        if (nextUnreadCounts[key] !== undefined) {
          nextUnreadCounts[key] = Math.max(0, nextUnreadCounts[key] + afterUnread - beforeUnread)
        }
        return next
      })
      if (columnChanged) changed = true
      return [key, columnChanged ? nextThreads : threads]
    }),
  )
  if (changed) {
    kanban$.threads.set(nextColumns)
    kanban$.unreadCounts.set(nextUnreadCounts)
  }
}

function reconcileThreadUnreadFromLoadedMessages(
  threadId: string,
  messages: Message[],
  nextCursor: string | undefined,
) {
  if (nextCursor) return
  const threadMessages = messages.filter((message) => message.thread_id === threadId)
  if (threadMessages.length === 0 || threadMessages.some((message) => message.unread)) return

  const thread = mail$.threads.get().find((item) => item.thread_id === threadId)
  if (!thread?.unread) return
  const unreadCount = Math.max(1, thread.unread_count ?? 0)
  mail$.threads.set(
    mail$.threads
      .get()
      .map((item) => (item.thread_id === threadId ? { ...item, unread: false, unread_count: 0 } : item)),
  )
  decrementFolderUnread(thread.account_id, thread.folder_id, unreadCount)
  updateKanbanThread(threadId, (item) => ({ ...item, unread: false, unread_count: 0 }))
}

export function removeKanbanThread(threadId: string) {
  const columns = kanban$.threads.get()
  let changed = false
  const nextColumns = Object.fromEntries(
    Object.entries(columns).map(([key, threads]) => {
      const nextThreads = threads.filter((thread) => thread.thread_id !== threadId)
      if (nextThreads.length !== threads.length) changed = true
      return [key, nextThreads]
    }),
  )
  if (changed) kanban$.threads.set(nextColumns)
}

export function findLocalThread(threadId: string): Message | undefined {
  const thread = mail$.threads.get().find((item) => item.thread_id === threadId)
  if (thread) return thread
  for (const threads of Object.values(kanban$.threads.get())) {
    const match = threads.find((item) => item.thread_id === threadId)
    if (match) return match
  }
  return mail$.messages.get().find((item) => item.thread_id === threadId)
}

// Click-to-open an attachment: the bridge hands it to the OS default
// application. Types off its allowlist (executables, macro-capable documents,
// archives — anything a default handler could turn into code execution) come
// back `opened: false` and fall through to the save dialog, which stays the
// behaviour for everything we won't open.
export async function openAttachment(att: { key: string | null; filename: string }) {
  if (!att.key) return
  try {
    const res = await invoke<{ opened: boolean; path?: string }>('mail.openAttachment', {
      key: att.key,
      filename: att.filename,
    })
    if (!res?.opened) await downloadAttachment(att)
  } catch {
    showToast(t('chat.couldNotOpenAttachment', { filename: att.filename }))
  }
}

// Save a local attachment to disk via the native save dialog. The bytes already
// live in the media cache (keyed); the bridge copies them to the chosen path.
export async function downloadAttachment(att: { key: string | null; filename: string }) {
  if (!att.key) return
  try {
    const res = await invoke<{ saved: boolean; path?: string }>('mail.saveAttachment', {
      key: att.key,
      filename: att.filename,
    })
    if (res?.saved) showToast(t('chat.savedAttachment', { filename: att.filename }))
  } catch {
    showToast(t('chat.couldNotSaveAttachment', { filename: att.filename }))
  }
}

// Save one message as a .eml file (its original RFC822 bytes) via the native
// save dialog. Unlike attachments, the raw bytes aren't in the media cache, so
// the bridge refetches them over IMAP — this fails offline, and a message still
// being sent has no server-side copy to fetch.
export async function saveMessageAsEml(message: Message) {
  if (!message?.id || isLocalSendId(message.id)) return
  try {
    const res = await invoke<{ saved: boolean; path?: string }>('mail.saveEml', {
      thread_id: message.thread_id,
      message_ids: [message.id],
      folder: message.folder_id,
      subject: message.subject,
    })
    if (res?.saved) showToast(t('chat.messageSaved'))
  } catch {
    showToast(t('chat.couldNotSaveMessage'))
  }
}

// Copy a keyed image onto the system clipboard. The webview's native "Copy
// Image" is inert in the Wails webview, so the bridge shells out to the same
// clipboard helpers used for pasting.
export async function copyAttachmentImage(att: { key: string | null }) {
  if (!att.key) return
  try {
    await invoke('mail.copyImage', { key: att.key })
    showToast(t('chat.imageCopied'))
  } catch {
    showToast(t('chat.couldNotCopyImage'))
  }
}

// The visible thread list after applying the active filter (all / unread / starred).
export function getFilteredThreads() {
  const threads = mail$.threads.get()
  // The starred folder already lists starred threads only; a leftover filter
  // mode from the previous mailbox must not hide rows here.
  if (isUnifiedStarred(ui$.selectedAccount.get(), ui$.selectedFolder.get())) return threads
  const filterMode = ui$.filterMode.get()
  const selected = ui$.selectedThread.get()
  return filterThreads(threads, filterMode, selected, mail$.readThreads.get())
}

// Move the selection up (delta -1) or down (delta +1) through the visible
// thread list, clamping at the ends (no wrap, so a held key doesn't loop back).
// Backs the j/k keyboard navigation.
export function selectAdjacentThread(delta: number) {
  const list = getFilteredThreads()
  if (list.length === 0) return
  const selected = ui$.selectedThread.get()
  const current = list.findIndex((thread) => thread.thread_id === selected)
  const next = current === -1 ? 0 : Math.min(list.length - 1, Math.max(0, current + delta))
  const target = list[next]
  if (target) ui$.selectedThread.set(target.thread_id)
}

export function getActiveThread() {
  const filtered = getFilteredThreads()
  const threads = mail$.threads.get()
  const selected = ui$.selectedThread.get()
  // Nothing selected means an empty conversation pane. Falling back to the top
  // of the list here would re-open — and so mark read — a thread the user never
  // picked, which is exactly what `loadThreads` refuses to do.
  if (!selected) return null
  const fromList = filtered.find((thread) => thread.thread_id === selected)
  if (fromList) return fromList
  const fromAllThreads = threads.find((thread) => thread.thread_id === selected)
  if (fromAllThreads) return fromAllThreads
  const kanbanColumns = kanban$.threads.get()
  for (const threads of Object.values(kanbanColumns)) {
    const match = threads.find((thread) => thread.thread_id === selected)
    if (match) return match
  }
  // The selected thread's row hasn't landed yet (a notification or kanban jump
  // that outran the list load). Wait for it rather than showing an unrelated
  // conversation from the list we happen to have.
  return null
}

// Guards against a slow load repainting the list after a newer one already did.
// A search is a live IMAP round trip — seconds, not milliseconds — so typing
// another character, clearing the box, or switching account/folder while one is
// in flight routinely finishes out of order. Every write below belongs to the
// newest call only; the losers drop their results (same idea as the kanban
// column loader's `columnLoadVersions` and mobile's `activeMailboxLoadToken`).
let threadLoadVersion = 0

// Opening a conversation is never passive: the message pane marks every visible
// unread message read as soon as it renders. So the thread list must not open a
// conversation on its own — switching account/folder (the unified inbox above
// all, since it lands on the newest mail across every account) would silently
// clear the unread flag on a thread the user never looked at. Selection follows
// a click, a j/k move, or the flows below that delete what was open and hand the
// slot to the replacement thread; every other load leaves it alone.
let reselectAfterThreadLoad = false

// View key of the refresh:true load currently out to the server, '' when none,
// tagged with the `threadLoadVersion` of the load holding it so only that load
// releases it. Read by the background-refresh guard below.
let pendingRefreshKey = ''
let pendingRefreshVersion = 0
// View key of a background refresh that stepped aside for the load above, ''
// when none. The load it yielded to read the cache before whatever prompted
// the refresh changed it — a post-send draft discard, say — so its rows are
// not the answer the refresh was after; it runs again once that load lands.
let deferredRefreshKey = ''

// Called by flows that clear `selectedThread` because the open conversation is
// leaving the list (delete, move, discard draft) and want the next load to open
// whatever takes its place. One-shot: consumed by the next `loadThreads`.
export function requestThreadReselect() {
  reselectAfterThreadLoad = true
}

type ThreadSearchStage = 'auto' | 'cache' | 'live'

// Identity of a thread-list view: the four inputs `loadThreads` reads and
// `superseded` watches, newline-joined like `kanbanColumnKey` (neither a folder
// id nor a single-line search box carries one). Both the loader and the list
// build the key from the same fields, so the list can tell "these rows are for
// what I'm showing" from "these rows are the previous view's".
export function threadListViewKey(account: string, folder: string, query: string, filter: string) {
  return [account, folder, query, filter].join('\n')
}

// Encoded t. keys include the subject branch and are stable across folders.
// Numeric IMAP UIDs and RSS item ids remain tied to their original location.
function starredConversationIdentity(thread: Message): string {
  if (thread.thread_id.includes('#rss#')) return thread.thread_id
  const key = thread.thread_id.slice(thread.thread_id.lastIndexOf('#') + 1)
  return key.startsWith('t.') ? `${thread.account_id}#${key}` : thread.thread_id
}

export async function loadThreads(refresh = true, searchStage: ThreadSearchStage = 'auto') {
  // A Kanban card temporarily points selectedFolder at the card's real mailbox
  // so thread actions have the right context. The normal mail list is hidden,
  // and treating that account-specific id as a unified role falls back to Inbox,
  // replacing the rows that should still be waiting for the mail view.
  if (kanban$.activeBoardId.peek()) {
    // A reselect request belongs to the load that was asked for, which is this
    // one; dropping it here keeps it from arming a later load in the mail view,
    // where it would open (and mark read) an unrelated conversation.
    reselectAfterThreadLoad = false
    return
  }

  const initialAccount = ui$.selectedAccount.get()
  const initialFolder = ui$.selectedFolder.get()
  const initialQuery = ui$.query.get()
  const initialFilter = ui$.filterMode.get()
  const activeAccount = accounts$.get().find((account) => account.id === initialAccount)
  // Starred is answered from the local cache, so there is no live stage to run.
  const canSearchLive =
    !isUnifiedStarred(initialAccount, initialFolder) &&
    (initialAccount === 'unified' || !isRssAccount(activeAccount, initialAccount))

  // Paint results from the local FTS index before starting the live IMAP
  // request. RSS search is already local, and background refreshes deliberately
  // remain cache-only.
  if (refresh && searchStage === 'auto' && initialQuery.trim() && canSearchLive) {
    await loadThreads(false, 'cache')
    if (
      ui$.selectedAccount.get() !== initialAccount ||
      ui$.selectedFolder.get() !== initialFolder ||
      ui$.query.get() !== initialQuery ||
      ui$.filterMode.get() !== initialFilter
    ) {
      return
    }
    await loadThreads(true, 'live')
    return
  }

  const selectedAcc = ui$.selectedAccount.get()
  const selectedFol = ui$.selectedFolder.get()
  const q = ui$.query.get()
  const filter = ui$.filterMode.get()
  const viewKey = threadListViewKey(selectedAcc, selectedFol, q, filter)

  // A background refresh steps aside for a server-bound load already running for
  // the same view. Taking the version from it would throw away the fresher rows
  // it is about to return, and — since a background load never settles a view —
  // would strand the list on the spinner: the foreground load loses `superseded`
  // when it lands, and nothing else is scheduled to try again. Nothing is lost by
  // skipping; the load in flight is asking the server the same question.
  // Only while the claiming load is still the newest one. A load another has
  // overtaken will drop its results, and it releases the claim on its own only
  // when its request finally lands — a slow or wedged search would keep every
  // background refresh of the view out until then.
  if (
    !refresh &&
    searchStage !== 'cache' &&
    pendingRefreshKey === viewKey &&
    pendingRefreshVersion === threadLoadVersion
  ) {
    deferredRefreshKey = viewKey
    return
  }

  const version = (threadLoadVersion += 1)
  if (refresh) {
    pendingRefreshKey = viewKey
    pendingRefreshVersion = version
    // This load reads the cache after anything a skipped refresh was reacting to.
    deferredRefreshKey = ''
  }
  // Hand the claim above back the moment this load stops being the one that will
  // write. Every background refresh of this view steps aside while it stands, so
  // a claim left behind by a load that gave up silences them all for as long as
  // the view is on screen — that is how a reply sent from a search left the
  // thread's card showing a Draft badge and a message count that still counted
  // the draft: the refresh the post-send discard runs was skipped for a search
  // load the next keystroke had already superseded.
  const releasePendingRefresh = () => {
    if (pendingRefreshVersion !== version) return
    pendingRefreshKey = ''
    pendingRefreshVersion = 0
  }
  // Asked at every point this load would drop its results, so it is also where
  // the claim is released.
  const superseded = () => {
    const stale =
      threadLoadVersion !== version ||
      ui$.selectedAccount.get() !== selectedAcc ||
      ui$.selectedFolder.get() !== selectedFol ||
      ui$.query.get() !== q ||
      ui$.filterMode.get() !== filter
    if (stale) releasePendingRefresh()
    return stale
  }
  const previousThreads = mail$.threads.get()
  const currentSelected = ui$.selectedThread.get()
  const previousThreadsCursor = mail$.threadsCursor.get()
  const previousAccountCursors = snapshotRecord(mail$.threadAccountCursors.get())
  const userInitiated = refresh || searchStage === 'cache'

  // A background refresh (a sync, not a user-initiated account/folder/query/filter
  // change) only re-fetches the first page of the thread list. If the user has
  // scrolled the list and loaded extra pages, replacing the whole array with just
  // the first page collapses it and resets the scroll position. In that case we
  // merge the fresh page into the list we already have instead.
  const backgroundRefresh = !refresh && searchStage !== 'cache' && previousThreads.length > 0
  const unifiedStarred = isUnifiedStarred(selectedAcc, selectedFol)
  const mergeBackground = backgroundRefresh && !unifiedStarred

  let allThreads: Message[] = []

  // Starred spans every account and every folder, so it is answered by a
  // cross-account cache query rather than the per-account folder fan-out. Its
  // rows are ordinary thread cards, so only the fetch is special-cased.
  if (isUnifiedStarred(selectedAcc, selectedFol)) {
    try {
      const res = await invoke<{ items: Message[]; next_cursor?: string }>('mail.starredItems', {
        query: q,
        filter,
        // Re-fetch every loaded row: stars can disappear and the core can pick
        // a different folder copy of the same conversation after a flag change.
        // Keeping absent rows or merging by folder-specific thread_id duplicates it.
        // Optimistically removed rows no longer count toward this loaded window.
        limit: backgroundRefresh ? Math.max(50, previousThreads.length) : 50,
      })
      if (superseded()) return
      allThreads = res.items ?? []
      mail$.threadsCursor.set(res.next_cursor ?? '')
      mail$.threadAccountCursors.set({})
    } catch (err) {
      if (superseded()) return
      console.error('Failed to load starred items:', err)
      mail$.threadsCursor.set('')
      mail$.threadAccountCursors.set({})
    }
  } else if (selectedAcc === 'unified') {
    const role = unifiedFolderRole(selectedFol)
    try {
      const result = await invoke<{
        threads: Message[]
        next_cursor?: string
        folder_unreads?: Record<string, number>
        failures?: Array<{ account_id: string; message: string }>
      }>('mail.threadList', {
        account_id: 'unified',
        folder_id: role,
        folder_role: role,
        query: q,
        filter,
        refresh,
      })
      if (superseded()) return
      allThreads = result.threads || []
      // Only the Inbox totals feed the side-nav badges; the other unified
      // folders have no badge to keep in sync.
      if (role === 'inbox') {
        for (const [accountId, unread] of Object.entries(result.folder_unreads ?? {})) {
          updateCachedFolderUnread(accountId, 'inbox', unread)
        }
      }
      for (const failure of result.failures ?? []) {
        console.error(`Failed to load threads for ${failure.account_id}: ${failure.message}`)
      }
      mail$.threadAccountCursors.set({})
      mail$.threadsCursor.set(result.next_cursor ?? '')
    } catch (err) {
      if (superseded()) return
      console.error('Failed to load unified threads:', err)
      mail$.threadAccountCursors.set({})
      mail$.threadsCursor.set('')
    }
  } else {
    try {
      const result = await invoke<{ threads: Message[]; next_cursor?: string; folder_unread?: number }>(
        'mail.threadList',
        {
          account_id: selectedAcc,
          folder_id: selectedFol,
          query: q,
          filter,
          refresh,
        },
      )
      if (superseded()) return
      if (typeof result.folder_unread === 'number') {
        updateCachedFolderUnread(selectedAcc, selectedFol, result.folder_unread)
      }
      allThreads = result.threads || []
      mail$.threadsCursor.set(result.next_cursor ?? '')
      mail$.threadAccountCursors.set({})
    } catch (err) {
      if (superseded()) return
      console.error('Failed to load threads:', err)
      mail$.threadsCursor.set('')
      mail$.threadAccountCursors.set({})
    }
  }

  if (filter !== 'all' && currentSelected && !allThreads.some((thread) => thread.thread_id === currentSelected)) {
    const selectedThread = previousThreads.find((thread) => thread.thread_id === currentSelected)
    const replacement =
      selectedThread &&
      allThreads.some((thread) => starredConversationIdentity(thread) === starredConversationIdentity(selectedThread))
    // Keep the conversation while reading clears its unread flag, but never
    // retain an unstarred row or duplicate a freshly chosen folder copy.
    if (selectedThread && (!unifiedStarred || (filter === 'unread' && selectedThread.starred && !replacement))) {
      allThreads = [...allThreads, selectedThread]
      allThreads.sort((a, b) => b.date - a.date)
    }
  }

  if (mergeBackground) {
    // Update the threads we already show with their fresh copies (new unread
    // counts, latest message, etc.), keep the extra pages the user loaded by
    // scrolling, and prepend any threads that are brand-new since the last load.
    // This preserves both the list length and the user's scroll position.
    const fetched = new Map(allThreads.map((thread) => [thread.thread_id, thread]))
    const previousIds = new Set(previousThreads.map((thread) => thread.thread_id))
    const brandNew = allThreads.filter((thread) => !previousIds.has(thread.thread_id))
    const updated = previousThreads.map((thread) => fetched.get(thread.thread_id) ?? thread)
    allThreads = brandNew.length > 0 ? [...brandNew, ...updated] : updated
    // Keep the cursor pointing past the last loaded page rather than resetting it
    // to the first page's cursor.
    mail$.threadsCursor.set(previousThreadsCursor)
    mail$.threadAccountCursors.set(previousAccountCursors)
  }

  mail$.threads.set(allThreads)
  // These rows now stand for this view — but only a load that went to the server
  // for them may say so, which is what `refresh` marks. The two cache-only kinds
  // both answer from the local index, so an empty result from either means "not
  // found *yet*", and settling the view on one puts "No matching mail" on screen
  // while the real answer is still coming:
  //   - the cache stage of a search, whose live IMAP half is the slow one, and
  //     the one that finds mail the index has not got;
  //   - a background refresh (sync event, feed edit), which fires on its own
  //     schedule and so can land in the gap between a keystroke and the
  //     debounced search, or between a folder switch and its own load.
  // Every view reaches the screen through an effect that loads it with
  // refresh:true, including the ones answered locally (Starred, RSS), so none
  // depends on a cache-only load to settle.
  // Only a load that got past `superseded` reaches here, so the captured fields
  // are still the ones on screen.
  if (refresh) {
    mail$.threadsLoadedKey.set(viewKey)
    releasePendingRefresh()
    // A background refresh that stepped aside for this load was asking about a
    // cache this load had already read — the draft a post-send discard removed
    // is still in the rows just written, so its card keeps the Draft badge and
    // counts the draft. Run the refresh now that nothing is in its way.
    if (deferredRefreshKey === viewKey) {
      deferredRefreshKey = ''
      void loadThreads(false).catch(console.error)
    }
  }

  const filtered = getFilteredThreads()
  // Consume the reselect request here rather than at the top of the load: a
  // superseded or replaced load returns above without ever reaching the
  // selection, and the request belongs to whichever load actually lands.
  const reselect = reselectAfterThreadLoad
  reselectAfterThreadLoad = false
  // In kanban view the open conversation is owned by kanban$.paneThreadId, not by
  // mail$.threads/filtered. Clicking a card sets selectedFolder (firing this load)
  // and selectedThread together; auto-selecting or snapping here would yank
  // selectedThread to an unrelated normal-view thread while the pane stays open on
  // the card — rendering the wrong conversation. So leave the selection alone.
  if (kanban$.activeBoardId.get()) {
    return
  }
  if (!currentSelected) {
    // Only a flow that just cleared the selection may fill it (see
    // `requestThreadReselect`); an empty pane otherwise stays empty.
    if (reselect) ui$.selectedThread.set(filtered[0]?.thread_id ?? '')
  } else if (
    // Only drop the selection on a user-initiated load (account/folder/query/
    // filter change, including the cache stage of a search). A background
    // refresh only re-fetches the first page, so an open thread the user
    // scrolled down to and opened from a later page would look "missing" and
    // get closed a second or two later.
    userInitiated &&
    !allThreads.some((thread) => thread.thread_id === currentSelected) &&
    // A selection whose conversation is still being fetched — a notification or
    // starred jump that set account, folder and thread together — isn't missing,
    // it just hasn't landed. Only close one that has settled.
    !mail$.threadLoading.get()
  ) {
    // The thread the user was reading is not in this view: close the pane rather
    // than opening an unrelated one for them.
    ui$.selectedThread.set('')
  }
}

export async function loadMoreThreads() {
  if (mail$.threadsLoadingMore.get()) return
  const selectedAcc = ui$.selectedAccount.get()
  const selectedFol = ui$.selectedFolder.get()
  const q = ui$.query.get()
  const filter = ui$.filterMode.get()
  const version = threadLoadVersion
  const stillCurrent = (cursor: string) =>
    threadLoadVersion === version &&
    ui$.selectedAccount.get() === selectedAcc &&
    ui$.selectedFolder.get() === selectedFol &&
    ui$.query.get() === q &&
    ui$.filterMode.get() === filter &&
    mail$.threadsCursor.get() === cursor
  // The starred filter is one unpaginated page; a search over it is paged like
  // any other, and every other view stops on an empty cursor below.
  if (!q.trim() && filter === 'starred') return

  mail$.threadsLoadingMore.set(true)
  try {
    let moreThreads: Message[] = []
    if (isUnifiedStarred(selectedAcc, selectedFol)) {
      const cursor = mail$.threadsCursor.get()
      if (!cursor) return
      const res = await invoke<{ items: Message[]; next_cursor?: string }>('mail.starredItems', {
        // The cursor walks the *filtered* set, so later pages must repeat the
        // query or they'd page through items the first page never showed.
        query: q,
        filter,
        limit: 50,
        before_cursor: cursor,
      })
      if (!stillCurrent(cursor)) return
      moreThreads = res.items || []
      mail$.threadsCursor.set(res.next_cursor ?? '')
    } else if (selectedAcc === 'unified') {
      const cursor = mail$.threadsCursor.get()
      if (!cursor) return
      const role = unifiedFolderRole(selectedFol)
      const res = await invoke<{
        threads: Message[]
        next_cursor?: string
        folder_unreads?: Record<string, number>
      }>('mail.threadList', {
        account_id: 'unified',
        folder_id: role,
        folder_role: role,
        query: q,
        filter,
        before_cursor: cursor,
        refresh: false,
      })
      if (!stillCurrent(cursor)) return
      if (role === 'inbox') {
        for (const [accountId, unread] of Object.entries(res.folder_unreads ?? {})) {
          updateCachedFolderUnread(accountId, 'inbox', unread)
        }
      }
      moreThreads = res.threads || []
      mail$.threadAccountCursors.set({})
      mail$.threadsCursor.set(res.next_cursor ?? '')
    } else {
      const cursor = mail$.threadsCursor.get()
      if (!cursor) return
      const res = await invoke<{ threads: Message[]; next_cursor?: string; folder_unread?: number }>(
        'mail.threadList',
        {
          account_id: selectedAcc,
          folder_id: selectedFol,
          query: q,
          filter,
          before_cursor: cursor,
          refresh: false,
        },
      )
      if (!stillCurrent(cursor)) return
      if (typeof res.folder_unread === 'number') updateCachedFolderUnread(selectedAcc, selectedFol, res.folder_unread)
      moreThreads = res.threads || []
      mail$.threadsCursor.set(res.next_cursor ?? '')
    }

    if (moreThreads.length > 0) {
      const existing = mail$.threads.get()
      const seen = new Set(existing.map((thread) => thread.thread_id))
      const merged = [...existing, ...moreThreads.filter((thread) => !seen.has(thread.thread_id))]
      if (selectedAcc === 'unified') {
        merged.sort((a, b) => b.date - a.date)
      }
      mail$.threads.set(merged)
    }
  } finally {
    mail$.threadsLoadingMore.set(false)
  }
}

export async function loadThread(threadId: string) {
  mail$.threadLoading.set(true)
  if (mail$.threadErrorId.get() === threadId) mail$.threadErrorId.set('')
  try {
    const result = await invoke<{ messages: Message[]; next_cursor?: string }>('mail.threadRead', {
      thread_id: threadId,
      limit: CONVERSATION_PAGE_SIZE,
    })
    // Guard against a stale response: the user may have switched threads while
    // this was in flight (e.g. during the ancestor fetch). Don't overwrite the
    // newer thread's messages — and let that newer load own the loading flag.
    if (ui$.selectedThread.get() !== threadId) return
    // Bodies still filling in the background arrive via the `mail.synced`
    // re-read; until then hide their placeholders rather than render empty
    // bubbles.
    const refreshed = result.messages.filter((message) => !message.body_missing)
    const messages = mergeRefreshedThreadMessages(mail$.messages.get(), refreshed, threadId)
    mail$.messages.set(messages)
    mail$.messagesCursor.set(result.next_cursor ?? '')
    mail$.messagesLoadingMore.set(false)
    // Reconcile against the unfiltered page: a hidden placeholder can still be
    // unread, and dropping it must not mark the thread read early.
    reconcileThreadUnreadFromLoadedMessages(threadId, result.messages, result.next_cursor)
  } catch (err) {
    // Without this the failure is silent: the finally below clears the
    // spinner and the reader sits blank. Flag the thread so the pane can
    // offer a retry; keep it only if the user is still looking at it.
    console.error('threadRead failed', err)
    if (ui$.selectedThread.get() === threadId) mail$.threadErrorId.set(threadId)
  } finally {
    if (ui$.selectedThread.get() === threadId) {
      mail$.threadLoading.set(false)
    }
  }
}

/**
 * Keep optimistic sends visible while the server's Sent copy catches up. Some
 * providers expose it over IMAP only after SMTP has returned (Proton Bridge can
 * take several seconds), so replacing the thread page wholesale creates a gap
 * where the reply disappears. Once the canonical row arrives, it replaces the
 * local bubble instead of rendering twice.
 */
export function mergeRefreshedThreadMessages(current: Message[], refreshed: Message[], threadId: string): Message[] {
  const canonicalMessageIds = new Set(
    refreshed.map((message) => normalizeMessageId(message.message_id)).filter(Boolean),
  )
  const unresolved = current.filter((message) => {
    if (message.thread_id !== threadId || !isLocalSendId(message.id)) return false
    const messageId = normalizeMessageId(message.message_id)
    return !messageId || !canonicalMessageIds.has(messageId)
  })
  // Fallback candidates: outgoing, non-draft rows this refresh newly revealed.
  // A message we were already showing before the send cannot be its server
  // copy, and a draft — even one holding this very reply — is not a sent copy.
  const known = new Set(current.map((message) => message.id))
  const candidates = refreshed.filter(
    (message) =>
      !isLocalSendId(message.id) &&
      !known.has(message.id) &&
      message.outgoing &&
      !isDraftFolder(message.folder_id, message.account_id),
  )
  // A bubble still waiting on its Message-ID has not been handed to SMTP yet, so
  // nothing this refresh reveals can be its copy — only an earlier reply of ours
  // that happens to look alike, which must not swallow it.
  const dispatched = unresolved.filter((message) => !!message.message_id || message.send_status !== 'sending')
  const paired = pairLocalSendsWithServerCopies(dispatched, candidates)
  const optimistic = unresolved.filter((message) => !paired.has(message.id))
  if (optimistic.length === 0) return refreshed
  return [...refreshed, ...optimistic].sort((a, b) => a.date - b.date)
}

/** How far the server's Date header may sit from the moment we rendered the
 * bubble and still be the same message — enough for a slow submission plus
 * modest clock skew, short enough not to swallow a genuinely later reply. */
const SENT_COPY_MATCH_WINDOW_SECONDS = 600

/**
 * Match optimistic bubbles to the server's copies of them when the Message-ID
 * we generated didn't come back. Proton Bridge replaces that id with one of its
 * own (`@protonmail.internalid`), so identity has to come from the envelope:
 * same account and sender, same subject, same recipients, and a send time close
 * to when we rendered the bubble.
 *
 * Two replies into one thread share every one of those fields, so pairing is
 * decided globally rather than by first match: every plausible pair is ranked
 * by whether the content matches and then by how far apart the two times are,
 * and pairs are taken best-first. That keeps a copy arriving out of order from
 * claiming the wrong bubble — which would hide one reply and show the other
 * twice — while still settling on time alone when a server reflows the body it
 * stored and no content match exists.
 *
 * Returns the ids of the bubbles that found a copy.
 */
function pairLocalSendsWithServerCopies(locals: Message[], candidates: Message[]): Set<string> {
  const pairs: { localId: string; candidateId: string; contentMismatch: number; skew: number }[] = []
  for (const local of locals) {
    for (const candidate of candidates) {
      if (!isPlausibleSentCopy(local, candidate)) continue
      pairs.push({
        localId: local.id,
        candidateId: candidate.id,
        contentMismatch: contentSignature(local) === contentSignature(candidate) ? 0 : 1,
        skew: Math.abs(candidate.date - local.date),
      })
    }
  }
  pairs.sort((a, b) => a.contentMismatch - b.contentMismatch || a.skew - b.skew)

  const pairedLocals = new Set<string>()
  const claimed = new Set<string>()
  for (const pair of pairs) {
    if (pairedLocals.has(pair.localId) || claimed.has(pair.candidateId)) continue
    pairedLocals.add(pair.localId)
    claimed.add(pair.candidateId)
  }
  return pairedLocals
}

/** The envelope test every pair must clear before ranking. */
function isPlausibleSentCopy(local: Message, candidate: Message): boolean {
  if (candidate.account_id !== local.account_id) return false
  if (bareAddr(candidate.from_addr ?? '') !== bareAddr(local.from_addr ?? '')) return false
  if ((candidate.subject ?? '').trim() !== (local.subject ?? '').trim()) return false
  if (recipientKey(candidate) !== recipientKey(local)) return false
  return Math.abs(candidate.date - local.date) <= SENT_COPY_MATCH_WINDOW_SECONDS
}

/** What distinguishes two replies that share an envelope: what they say and
 * what they carry. Whitespace-insensitive, since a server may rewrap the body
 * it stored — a mismatch demotes a pair rather than rejecting it. */
function contentSignature(message: Message): string {
  const body = (message.body ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const files = (message.attachments ?? [])
    .map((attachment) => attachment.filename.trim().toLowerCase())
    .sort()
    .join('|')
  return `${files}\u0000${body}`
}

/** Order-independent set of the bare To/Cc addresses, for envelope comparison. */
function recipientKey(message: Message): string {
  return [...splitAddressList(message.to), ...splitAddressList(message.cc)]
    .map(bareAddr)
    .filter(Boolean)
    .sort()
    .join(',')
}

// The sidecar accepts RFC Message-IDs both with and without their header angle
// brackets. Cached messages retain the spelling returned by the mail server,
// so every frontend identity comparison uses this same equivalence.
export function normalizeMessageId(value: string | undefined): string {
  return (value ?? '').trim().replace(/^<|>$/g, '').toLowerCase()
}

export async function loadMoreMessages(threadId: string) {
  const cursor = mail$.messagesCursor.get()
  if (!cursor || mail$.messagesLoadingMore.get()) return
  // Guard against a stale click after the thread switched out from under us.
  if (ui$.selectedThread.get() !== threadId) return
  mail$.messagesLoadingMore.set(true)
  try {
    const result = await invoke<{ messages: Message[]; next_cursor?: string }>('mail.threadRead', {
      thread_id: threadId,
      limit: CONVERSATION_PAGE_SIZE,
      before_cursor: cursor,
    })
    if (ui$.selectedThread.get() !== threadId) return
    // Prepend the older page; engine returns ascending order within the page.
    const existing = mail$.messages.get()
    const seen = new Set(existing.map((m) => m.id))
    const merged = [...result.messages.filter((m) => !seen.has(m.id) && !m.body_missing), ...existing]
    mail$.messages.set(merged)
    mail$.messagesCursor.set(result.next_cursor ?? '')
  } finally {
    mail$.messagesLoadingMore.set(false)
  }
}

export function uniqueThreadItems(items: BulkSelectionItem[]) {
  const byThread = new Map<string, BulkSelectionItem>()
  for (const item of items) {
    if (!item.threadId || item.kind !== 'mail') continue
    if (!byThread.has(item.threadId)) byThread.set(item.threadId, item)
  }
  return [...byThread.values()]
}

export async function syncMail() {
  mail$.readThreads.set({})
  const selectedAcc = ui$.selectedAccount.get()
  if (!selectedAcc) return

  ui$.busy.set(true)
  try {
    if (selectedAcc === 'unified') {
      const accounts = unifiedAccounts()
      await Promise.all(
        accounts.map((acc) =>
          invoke('mail.sync', { account_id: acc.id }).catch((err) =>
            console.error(`Sync failed for ${acc.email}:`, err),
          ),
        ),
      )
    } else {
      await invoke('mail.sync', { account_id: selectedAcc })
    }
    await loadThreads()
    showToast(t('mail.toast.synced'))
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('mail.toast.syncFailed'), 'error')
  } finally {
    ui$.busy.set(false)
  }
}
