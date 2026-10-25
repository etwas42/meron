import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { firstDayOfWeek, gridRange, monthGrid } from '../lib/calendarGrid'
import { errorMessage } from '../lib/errors'
import { t } from '../lib/i18n'
import type { Invite, InviteResponse, Message } from '../types'
import { openThreadTabById } from './compose'
import { compose$ } from './composeState'
import { mail$ } from './mailState'
import { settings$ } from './settings'
import { openTasksPanel } from './tasks'
import { showToast, showUndoToast, ui$ } from './ui'

export type CalendarRepeat = '' | 'daily' | 'weekly' | 'monthly' | 'yearly'

/** One occurrence in a calendar range, as `calendar.events` shapes it (see
 * meron-core/src/calendar/events.rs). Times are epoch seconds; an all-day
 * item's are UTC midnights with `end` exclusive. */
export type CalendarItem = {
  /** The event's id (or the task's, for `source: 'task'`). */
  id: string
  /** Unique within one answer: a repeating event has one item per occurrence. */
  key: string
  source: 'event' | 'invite' | 'task'
  title: string
  notes: string
  location: string
  start: number
  end: number
  all_day: boolean
  recurring: boolean
  repeat: CalendarRepeat
  account: string
  thread_id: string
  message_id: string
  /** An invitation's answer: `accepted` or `tentative`. */
  response: string
  /** A task's list. */
  list_id?: string
}

/** What the event editor sends, and what it was opened on. */
export type EventInput = {
  title: string
  notes: string
  location: string
  start: number
  end: number
  all_day: boolean
  repeat: CalendarRepeat
  /** Editing a repeating event: the start of the occurrence the editor was
   * opened on, so the core moves the series by the change rather than
   * restarting it there. */
  occurrence_start?: number
}

export type EventEditor = { mode: 'new'; day: number } | { mode: 'edit'; item: CalendarItem }

export const calendar$ = observable({
  /** Any instant in the month on show, epoch milliseconds. */
  month: Date.now(),
  items: [] as CalendarItem[],
  loading: false,
  editor: null as EventEditor | null,
})

let loadSeq = 0

/** Show the calendar in the main pane, in place of mail or a board. */
export function openCalendar() {
  ui$.calendarOpen.set(true)
  void loadCalendar()
}

export function closeCalendar() {
  ui$.calendarOpen.set(false)
  calendar$.editor.set(null)
}

// A composer or reader tab opened while the calendar is showing (the rail's
// compose button, a shortcut, "Open mail") lives in the mail pane the calendar
// replaces, so make way for it.
compose$.activeTab.onChange(({ value }) => {
  if (value && ui$.calendarOpen.peek()) closeCalendar()
})

export function toggleCalendar() {
  if (ui$.calendarOpen.peek()) closeCalendar()
  else openCalendar()
}

/** Re-read the month on show. A read that finishes after a newer one started
 * is dropped, so paging quickly lands on the month the user stopped at. */
export async function loadCalendar() {
  const seq = ++loadSeq
  // The grid CalendarView draws, week start included, or its first days go unasked.
  const days = monthGrid(new Date(calendar$.month.peek()), firstDayOfWeek())
  const { from, to } = gridRange(days)
  calendar$.loading.set(true)
  try {
    const res = await invoke<{ events?: CalendarItem[] }>('calendar.events', {
      from,
      to,
      include_tasks: settings$.tasksEnabled.peek(),
    })
    if (seq === loadSeq) calendar$.items.set(res?.events ?? [])
  } catch (error) {
    if (seq === loadSeq) showToast(errorMessage(error, t('calendar.loadFailed')), 'error')
  } finally {
    if (seq === loadSeq) calendar$.loading.set(false)
  }
}

export function shiftMonth(delta: number) {
  const month = new Date(calendar$.month.peek())
  calendar$.month.set(new Date(month.getFullYear(), month.getMonth() + delta, 1).getTime())
  void loadCalendar()
}

export function goToToday() {
  calendar$.month.set(Date.now())
  void loadCalendar()
}

export async function createEvent(input: EventInput): Promise<boolean> {
  try {
    await invoke('calendar.create', input)
  } catch (error) {
    showToast(errorMessage(error, t('calendar.saveFailed')), 'error')
    return false
  }
  await loadCalendar()
  return true
}

export async function updateEvent(eventId: string, input: EventInput): Promise<boolean> {
  try {
    await invoke('calendar.update', { event_id: eventId, ...input })
  } catch (error) {
    showToast(errorMessage(error, t('calendar.saveFailed')), 'error')
    return false
  }
  await loadCalendar()
  return true
}

/** Delete an event, with an Undo that hands the core back what it removed:
 * the calendar lives only on this device, so a delete is otherwise final. */
export async function deleteEvent(eventId: string) {
  let restore: unknown = null
  try {
    const res = await invoke<{ restore?: unknown }>('calendar.delete', { event_id: eventId })
    restore = res?.restore ?? null
  } catch (error) {
    showToast(errorMessage(error, t('calendar.saveFailed')), 'error')
    return
  }
  clearInviteEvent(eventId)
  await loadCalendar()
  if (!restore) return
  showUndoToast(t('calendar.eventDeleted'), () => {
    void invoke('calendar.restore', { restore }).then(() => loadCalendar())
  })
}

/** What pressing an item in the grid does: edit an event, open an invitation
 * in the editor (its mail is a button away), show a task in its list. */
export function openCalendarItem(item: CalendarItem) {
  if (item.source === 'task') {
    void openTasksPanel(item.list_id ?? '')
    return
  }
  calendar$.editor.set({ mode: 'edit', item })
}

export async function openEventMail(threadId: string) {
  if (!threadId) return
  // The conversation opens in the mail pane, which the calendar replaces;
  // without a tab of its own it would not otherwise make way.
  closeCalendar()
  await openThreadTabById(threadId, t('tasks.mailNotFound'))
}

/** Show `changes` on every loaded copy of the invitation — the original, an
 * update to it, the same message in another folder — and only of the same
 * occurrence: an answer about one date is not one about the series. */
function updateInvite(message: Message, changes: Partial<Invite>) {
  const invite = message.invite
  if (!invite) return
  mail$.messages.set(
    mail$.messages
      .get()
      .map((loaded) =>
        loaded.account_id === message.account_id &&
        loaded.invite?.uid === invite.uid &&
        loaded.invite.recurrence_id === invite.recurrence_id
          ? { ...loaded, invite: { ...loaded.invite, ...changes } }
          : loaded,
      ),
  )
}

/** A loaded invitation whose event was just taken out of the calendar no
 * longer offers to take it out. */
function clearInviteEvent(eventId: string) {
  mail$.messages.set(
    mail$.messages
      .get()
      .map((message) =>
        message.invite?.event_id === eventId ? { ...message, invite: { ...message.invite, event_id: '' } } : message,
      ),
  )
}

/** Take a cancelled invitation out of the calendar: the occurrence it names,
 * or the whole event when the series is cancelled. Nothing is sent. */
export async function removeInviteFromCalendar(message: Message) {
  const invite = message.invite
  const eventId = invite?.event_id
  if (!invite || !eventId) return
  try {
    await invoke('invite.removeFromCalendar', { message: message.id })
  } catch (error) {
    showToast(errorMessage(error, t('calendar.saveFailed')), 'error')
    return
  }
  if (invite.recurrence_id === 0) {
    clearInviteEvent(eventId)
  } else {
    // Only this occurrence went: other cancelled dates of the series can
    // still be taken out.
    updateInvite(message, { event_id: '' })
  }
  if (ui$.calendarOpen.peek()) void loadCalendar()
}

/** Put an answered invitation back in the calendar — after its event was
 * deleted — with the answer already given and nothing sent. */
export async function addInviteToCalendar(message: Message) {
  const invite = message.invite
  if (!invite) return
  let eventId = ''
  try {
    const res = await invoke<{ event_id?: string }>('invite.addToCalendar', {
      message: message.id,
      thread_id: message.thread_id,
    })
    eventId = res?.event_id ?? ''
  } catch (error) {
    showToast(errorMessage(error, t('calendar.saveFailed')), 'error')
    return
  }
  updateInvite(message, { event_id: eventId })
  if (ui$.calendarOpen.peek()) void loadCalendar()
}

/** Answer an invitation: the core sends the organizer an iMIP reply, records
 * the answer and files the event in the calendar. The card shows it straight
 * away and goes back if the send fails. */
export async function respondToInvite(message: Message, response: InviteResponse) {
  const invite = message.invite
  if (!invite) return
  const previous = invite.response
  updateInvite(message, { response })
  try {
    const res = await invoke<{ event_id?: string }>('invite.respond', {
      message: message.id,
      thread_id: message.thread_id,
      response,
    })
    // Filed in the calendar now, or (declined) taken out of it. A declined
    // series takes its event out from under every message that pointed at it;
    // a declined occurrence leaves the series, and the other dates, in place.
    const eventId = res?.event_id ?? ''
    if (!eventId && invite.event_id && invite.recurrence_id === 0) clearInviteEvent(invite.event_id)
    updateInvite(message, { event_id: eventId })
  } catch (error) {
    updateInvite(message, { response: previous })
    showToast(errorMessage(error, t('invite.respondFailed')), 'error')
    return
  }
  if (ui$.calendarOpen.peek()) void loadCalendar()
}
