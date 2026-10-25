import { observable } from '@legendapp/state'

// Connectivity / sync health, cleared by successful syncs and reconnects.
// `error` is the last mail sync failure message, or null when mail is syncing
// fine; `account` is the mail account that failed, so a different account's
// success (e.g. RSS) can't dismiss the banner. ConnectivityBanner reads this;
// nothing here talks to the bridge directly.
export const connectivity$ = observable({
  error: null as string | null,
  account: null as string | null,
})

export function setSyncError(account: string | null, message: string) {
  connectivity$.account.set(account)
  connectivity$.error.set(message)
}

export function dismissSyncError() {
  connectivity$.error.set(null)
  connectivity$.account.set(null)
}

// Clear the banner when a mail sync or reconnect succeeds. Scoped to the failing
// account: success for another account (notably RSS) must not dismiss an outage
// on the account that errored. When either side is unknown, clear conservatively.
export function clearSyncErrorFor(account: string | null) {
  const erroring = connectivity$.account.get()
  if (erroring && account && erroring !== account) return
  connectivity$.error.set(null)
  connectivity$.account.set(null)
}
