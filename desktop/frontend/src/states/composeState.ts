import { observable } from '@legendapp/state'
import { t } from '../lib/i18n'
import type { ComposeDraft, ComposerAttachment, MessageTab } from '../types'
import { invoke } from '../lib/bridge'
import type { SignatureMark } from '../lib/signature'

// Compose/reader-tab + draft state. Reader tabs open using the account's
// conversation view preference; compose tabs hold a full-editor draft. The
// quick-reply composer (composer / composerAttachments) and per-thread quick
// drafts live here too. Persisted to localStorage (volatile editor buffers, not
// DB settings).

// Persisted full-editor drafts. Attachments are intentionally NOT persisted —
// their base64 payloads would quickly blow past localStorage's ~5MB budget.
// Only text fields survive restarts; the user reattaches files if needed.
export const COMPOSE_TABS_KEY = 'meron-compose-tabs'

// Local placeholder used until the first save asks meron-core for the stable
// RFC Message-ID. It is never sent to IMAP/SMTP.
/**
 * A placeholder draft id, replaced by a server-allocated one on the first save.
 * Exported because a draft that moves to another account needs a new one: the
 * allocated id belongs to the account whose Drafts folder holds that copy.
 */
export const newDraftMessageId = () => `local-draft-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`

export async function allocateMessageIdentity(accountId: string, draft: boolean): Promise<string> {
  const result = await invoke<{ message_id: string }>('mail.allocateIdentity', { account_id: accountId, draft })
  if (!result.message_id) throw new Error('Core did not allocate a message identity')
  return result.message_id
}

export type PersistedComposeTab = {
  id: string
  subject: string
  compose: Omit<ComposeDraft, 'attachments'> & { attachments: [] }
}
export function hasExtraComposeHeaders(compose: Pick<ComposeDraft, 'cc' | 'bcc'>): boolean {
  return !!(compose.cc?.trim() || compose.bcc?.trim())
}
function loadPersistedComposeTabs(): MessageTab[] {
  try {
    const raw = localStorage.getItem(COMPOSE_TABS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PersistedComposeTab[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t) => t && t.compose && typeof t.compose.to === 'string')
      .map<MessageTab>((t) => ({
        id: t.id,
        kind: 'compose',
        messageId: '',
        threadId: '',
        subject: t.subject || t.compose.subject || 'New message',
        from: '',
        body: '',
        viewMode: 'plain',
        compose: {
          ...t.compose,
          fromEmail: t.compose.fromEmail ?? '',
          showCcBcc: t.compose.showCcBcc && hasExtraComposeHeaders(t.compose),
          // Backfill for tabs persisted before draftMessageId existed, so the
          // first autosave after restart still replaces rather than duplicates.
          draftMessageId: t.compose.draftMessageId || newDraftMessageId(),
          attachments: [],
        },
      }))
  } catch {
    return []
  }
}
const initialComposeTabs = loadPersistedComposeTabs()

export const compose$ = observable({
  // Reader tabs for messages opened in "HTML mode"; activeTab "" = conversation view.
  // Re-hydrate any compose tabs whose drafts were persisted from the previous run.
  tabs: initialComposeTabs as MessageTab[],
  activeTab: '',
  // The thread shown by the "Current" conversation tab. The message pane renders a
  // single selectedThread, so a thread tab has to retarget selectedThread to load
  // its own messages. We remember the Current tab's thread here so switching to a
  // thread tab and back restores the conversation it was showing instead of
  // adopting the thread tab's. Kept in sync below while the Current tab is active.
  conversationThread: '',
  composer: '',
  composerAttachments: [] as ComposerAttachment[],
  // Server-side draft backing the active thread's quick reply, shared with the
  // full composer's saveDraft/discardDraft mechanism (mail.saveDraft/
  // mail.discardDraft) rather than a separate persistence path. Reset on
  // thread switch; re-derived from the thread's tail message when it's a
  // saved draft (see hydrateQuickReplyFromTailDraft below).
  quickReplyDraftId: '',
  quickReplyDraftSaved: false,
  // Exact owner of quickReplyDraftId. The selected thread can change before
  // its card or messages load, so neither collection is a reliable ownership
  // proxy when the quick-reply component mounts or remounts.
  quickReplyDraftThreadId: '',
  // Normalized ids of the server-side drafts a send has taken over, kept until
  // the post-send discard settles. The quick reply clears its own draft state
  // the moment it hands the text to the send, so without this a background
  // thread refresh landing in that window would render the still-cached draft
  // right above the message it was just sent as.
  sendingDraftIds: [] as string[],
  // Send-as address explicitly chosen for the active thread's quick reply, set
  // by the From indicator's picker. Empty means "auto" — fall back to the alias
  // the original was delivered to (detectAliasFrom). Reset on thread switch, so
  // an override never leaks into the next conversation.
  quickReplyFrom: '',
  // The signature this app seeded into the quick reply, or null when there is
  // none to account for — the account sends none, or the body was hydrated from
  // a saved draft that already carries its own.
  //
  // Unlike the full composer's tracking (see lib/signature's SignatureTracking)
  // this needs no third "inserted nothing, but managed" state: a quick reply
  // cannot change sending account, since its From picker only offers aliases of
  // the one account and those all share a signature. With nothing to swap, the
  // only question ever asked of this is which part of the box is the user's.
  quickReplySignature: null as SignatureMark | null,
})
