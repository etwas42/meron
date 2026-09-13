//! Folder and message sync against the server, including companion folders.

use std::sync::Arc;
use std::time::Duration;

use crate::{imap, store};

use super::*;

/// Reconnect to IMAP, list folders, and refresh the store.
pub async fn sync_folders(
    engine: &Arc<Engine>,
    account: &str,
) -> anyhow::Result<Vec<imap::Folder>> {
    let folders = engine
        .with_read_session(account, |session| {
            Box::pin(async move { imap::list_folders(session).await })
        })
        .await?;
    crate::mlog!(
        crate::log::Level::Debug,
        "mail.sync",
        "folders account={account}: {} listed [{}]",
        folders.len(),
        folders
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let db = engine.db.lock().unwrap();
    store::upsert_folders(&db, account, &folders)?;
    Ok(folders)
}

/// Update every physical copy selected by a star action. Commit each mailbox to
/// the cache only after its server write succeeds, including on partial failure.
pub async fn mark_starred_copies(
    engine: &Engine,
    account: &str,
    targets: &std::collections::BTreeMap<String, Vec<u32>>,
    starred: bool,
) -> anyhow::Result<()> {
    for (folder, uids) in targets {
        engine
            .with_preflighted_write_session(
                account,
                |session| {
                    let folder = folder.clone();
                    Box::pin(async move { imap::prepare_flag_update(session, &folder).await })
                },
                |session| {
                    let uids = uids.clone();
                    Box::pin(async move { imap::store_starred(session, &uids, starred).await })
                },
            )
            .await?;
        let db = engine.db.lock().unwrap();
        for uid in uids {
            store::update_message_starred(&db, account, folder, *uid, starred)?;
        }
    }
    Ok(())
}

/// Delete messages on the server. Returns `None` for a permanent expunge
/// (Drafts, or items already in Trash), or `Some(trash)` when moved to Trash.
pub async fn delete_to_trash(
    engine: &Engine,
    account: &str,
    folder: &str,
    uids: &[u32],
) -> anyhow::Result<Option<String>> {
    engine
        .with_write_session(account, |session| {
            let folder = folder.to_string();
            let uids = uids.to_vec();
            Box::pin(async move {
                let drafts = imap::find_drafts_folder(session).await?;
                if drafts.as_deref() == Some(folder.as_str()) {
                    imap::expunge_uids(session, &folder, &uids).await?;
                    return anyhow::Ok(None);
                }
                let trash = imap::find_trash_folder(session)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("Trash folder not found for this account"))?;
                if trash == folder {
                    imap::expunge_uids(session, &folder, &uids).await?;
                    return anyhow::Ok(None);
                }
                imap::move_to_folder(session, &folder, &trash, &uids).await?;
                anyhow::Ok(Some(trash))
            })
        })
        .await
}

/// Reconnect to IMAP, fetch the most recent `limit` messages of a folder into
/// the store, resetting cached messages if the server's UIDVALIDITY changed.
pub struct SyncMessagesResult {
    pub count: usize,
    pub messages: Vec<imap::MessageHeader>,
}

/// Rebuild what the batched sync would have produced, for a folder holding at
/// least one message whose FETCH response cannot be parsed. Establishes the
/// window with [`recover_recent_batch`], then re-runs the best-effort flag
/// reconciliation and UID listing that the failed attempt never reached.
pub(super) async fn sync_state_isolating_unparseable(
    engine: &Arc<Engine>,
    account: &str,
    folder: &str,
    limit: u32,
    prior_modseq: u64,
    prior_validity: u32,
) -> anyhow::Result<(
    imap::RecentBatch,
    Option<imap::FlagSync>,
    Option<std::collections::HashSet<u32>>,
)> {
    let batch = recover_recent_batch(engine, account, folder, limit).await?;
    let uidvalidity = batch.uidvalidity;
    let (flag_sync, server_uids) = engine
        .with_read_session(account, |session| {
            let folder = folder.to_string();
            Box::pin(async move {
                let validity_matches = prior_validity != 0 && prior_validity == uidvalidity;
                let flag_sync = imap::sync_flags(session, &folder, prior_modseq, validity_matches)
                    .await
                    .ok();
                let server_uids = imap::list_all_uids(session, &folder).await.ok();
                anyhow::Ok((flag_sync, server_uids))
            })
        })
        .await
        .unwrap_or((None, None));
    Ok((batch, flag_sync, server_uids))
}

/// [`imap::fetch_recent`] for one folder, recovering from messages whose FETCH
/// response cannot be parsed instead of failing the whole batch. Prefer this to
/// calling `imap::fetch_recent` inside a session closure.
///
/// Read-only, so it must not share a session with a mutating command: a wedged
/// connection has to be discarded, and a mutation that already reached the
/// server must never be retried. Run the mutation first, then call this.
pub async fn fetch_recent_resilient(
    engine: &Arc<Engine>,
    account: &str,
    folder: &str,
    limit: u32,
) -> anyhow::Result<imap::RecentBatch> {
    let attempt = engine
        .with_read_session(account, |session| {
            let folder = folder.to_string();
            Box::pin(async move { imap::fetch_recent(session, &folder, limit).await })
        })
        .await;
    match attempt {
        Ok(batch) => Ok(batch),
        Err(err) if imap::is_unparseable_response(&err) => {
            crate::mlog!(
                crate::log::Level::Warn,
                "mail.sync",
                "account={account} folder={folder}: unparseable FETCH response, \
                 re-reading the window message by message: {err:#}"
            );
            recover_recent_batch(engine, account, folder, limit).await
        }
        Err(err) => Err(err),
    }
}

/// Re-read the recent window of `folder` while working around messages whose
/// FETCH response cannot be parsed. Establishes the window as UIDs (a
/// `UID SEARCH` reply is immune to the failure), then reads it in ranges that
/// exclude the offending messages.
pub(super) async fn recover_recent_batch(
    engine: &Arc<Engine>,
    account: &str,
    folder: &str,
    limit: u32,
) -> anyhow::Result<imap::RecentBatch> {
    let (uidvalidity, uid_next, uids) = engine
        .with_read_session(account, |session| {
            let folder = folder.to_string();
            Box::pin(async move { imap::recent_uids(session, &folder, limit).await })
        })
        .await?;
    let (messages, skipped) =
        fetch_headers_isolating_unparseable(engine, account, folder, uids).await?;
    if !skipped.is_empty() {
        crate::mlog!(
            crate::log::Level::Warn,
            "mail.sync",
            "account={account} folder={folder}: {} of {} messages skipped as unreadable: {skipped:?}",
            skipped.len(),
            messages.len() + skipped.len()
        );
    }
    Ok(imap::RecentBatch {
        uidvalidity,
        uid_next,
        messages,
    })
}

/// Ceiling on FETCH attempts one poison-message recovery may spend. A run with
/// a single bad message costs about `2 * log2(window)` attempts; this only
/// bites when a folder is riddled with them, where the right answer is to store
/// what we have rather than reconnect dozens of times.
pub(super) const ISOLATION_ATTEMPT_LIMIT: usize = 32;

/// Fetch headers for `uids`, working around messages whose FETCH response the
/// IMAP parser rejects (see [`imap::is_unparseable_response`]).
///
/// Such a response wedges the connection it arrived on, so it cannot be skipped
/// mid-stream — the session has to go and the range has to be re-fetched
/// without it. This halves any failing range until the offending message sits
/// alone, drops just that one, and keeps its neighbours. Every attempt runs
/// through `with_read_session`, which discards the failed session and hands the
/// retry a fresh connection.
///
/// Returns the headers it could read plus the UIDs it gave up on. A genuine
/// network or server error aborts, since retrying narrower ranges would not
/// help.
pub(super) async fn fetch_headers_isolating_unparseable(
    engine: &Arc<Engine>,
    account: &str,
    folder: &str,
    uids: Vec<u32>,
) -> anyhow::Result<(Vec<imap::MessageHeader>, Vec<u32>)> {
    let mut pending = vec![uids];
    let mut out: Vec<imap::MessageHeader> = Vec::new();
    let mut skipped: Vec<u32> = Vec::new();
    let mut attempts = 0usize;

    while let Some(chunk) = pending.pop() {
        if chunk.is_empty() {
            continue;
        }
        if attempts >= ISOLATION_ATTEMPT_LIMIT {
            let abandoned: usize = pending.iter().map(Vec::len).sum::<usize>() + chunk.len();
            crate::mlog!(
                crate::log::Level::Warn,
                "mail.sync",
                "account={account} folder={folder}: giving up isolating unparseable \
                 messages after {attempts} fetches, {abandoned} UIDs left unread"
            );
            break;
        }
        attempts += 1;
        let result = engine
            .with_read_session(account, |session| {
                let folder = folder.to_string();
                let chunk = chunk.clone();
                Box::pin(async move { imap::fetch_headers_by_uid(session, &folder, &chunk).await })
            })
            .await;
        match result {
            Ok(headers) => out.extend(headers),
            Err(err) if !imap::is_unparseable_response(&err) => return Err(err),
            Err(err) if chunk.len() == 1 => {
                crate::mlog!(
                    crate::log::Level::Warn,
                    "mail.sync",
                    "account={account} folder={folder}: skipping uid={}, its FETCH \
                     response could not be parsed: {err:#}",
                    chunk[0]
                );
                skipped.push(chunk[0]);
            }
            Err(_) => {
                // Push the tail first so the halves are attempted in UID order.
                let mid = chunk.len() / 2;
                pending.push(chunk[mid..].to_vec());
                pending.push(chunk[..mid].to_vec());
            }
        }
    }

    out.sort_unstable_by_key(|header| std::cmp::Reverse(header.uid));
    Ok((out, skipped))
}

pub async fn sync_messages(
    engine: &Arc<Engine>,
    account: &str,
    folder: &str,
    limit: u32,
) -> anyhow::Result<SyncMessagesResult> {
    // Read the prior sync position before any network I/O so we can ask the
    // server for only the flag changes since then (CONDSTORE CHANGEDSINCE).
    let (prior_modseq, prior_validity) = {
        let db = engine.db.lock().unwrap();
        store::backfill_observed_mail_identities(&db, account)?;
        let modseq = store::get_folder_modseq(&db, account, folder)?;
        let validity = store::get_folder_state(&db, account, folder)?
            .map(|(v, _)| v)
            .unwrap_or(0);
        (modseq, validity)
    };

    let attempt = engine
        .with_read_session(account, |session| {
            let folder = folder.to_string();
            Box::pin(async move {
                let batch = imap::fetch_recent(session, &folder, limit).await?;
                // Reconcile \Seen across the whole folder (catches reads on other
                // devices, even for messages older than the recent window).
                // Best-effort: a no-op when there's no baseline, UIDVALIDITY changed,
                // or the server lacks CONDSTORE.
                let validity_matches = prior_validity != 0 && prior_validity == batch.uidvalidity;
                let flag_sync = imap::sync_flags(session, &folder, prior_modseq, validity_matches)
                    .await
                    .ok();
                // Server-side UID set so we can drop locally cached messages another
                // client moved or deleted. Best-effort: a failure here skips the prune.
                let server_uids = imap::list_all_uids(session, &folder).await.ok();
                anyhow::Ok((batch, flag_sync, server_uids))
            })
        })
        .await;
    // A message whose FETCH response we cannot parse takes the whole batch down
    // with it, and does so again on every later sync. Re-read the window a
    // narrower range at a time so the rest of the folder still syncs.
    let (batch, flag_sync, server_uids) = match attempt {
        Ok(state) => state,
        Err(err) if imap::is_unparseable_response(&err) => {
            crate::mlog!(
                crate::log::Level::Warn,
                "mail.sync",
                "account={account} folder={folder}: unparseable FETCH response, \
                 re-reading the window message by message: {err:#}"
            );
            sync_state_isolating_unparseable(
                engine,
                account,
                folder,
                limit,
                prior_modseq,
                prior_validity,
            )
            .await?
        }
        Err(err) => return Err(err),
    };

    let synced_messages = batch.messages.clone();
    let count = synced_messages.len();
    crate::mlog!(
        crate::log::Level::Debug,
        "mail.sync",
        "messages account={account} folder={folder}: fetched={count} \
         uidvalidity={} uid_next={} prior_validity={prior_validity} server_uids={}",
        batch.uidvalidity,
        batch.uid_next,
        server_uids.as_ref().map_or(-1, |u| u.len() as i64)
    );
    let db = engine.db.lock().unwrap();
    if prior_validity != 0 && prior_validity != batch.uidvalidity {
        store::clear_folder_messages(&db, account, folder)?;
    }
    store::upsert_messages(&db, account, folder, &batch.messages)?;
    // Make sure the folder is represented in the folders table so its unread
    // count surfaces (tray dot / badges) even before a full folder LIST sync —
    // which, in the unified view, may never run for this account.
    store::ensure_folder(&db, account, folder)?;
    if let Some(uids) = server_uids.as_ref() {
        let validity_ok = prior_validity == 0 || prior_validity == batch.uidvalidity;
        // An empty UID set means "the server holds nothing here" only if the
        // fetch also came back empty. Having just read `count` messages out of
        // this same mailbox, an empty SEARCH result contradicts itself — the
        // connection lied (see the CONDSTORE desync in imap::sync_flags) — and
        // pruning against it would delete the very messages just stored.
        let uids_credible = !uids.is_empty() || count == 0;
        if validity_ok && uids_credible {
            store::prune_missing_messages(&db, account, folder, uids)?;
        } else if !uids_credible {
            crate::mlog!(
                crate::log::Level::Warn,
                "mail.sync",
                "skipping prune for account={account} folder={folder}: \
                 UID SEARCH returned no UIDs but {count} messages were fetched"
            );
        }
    }
    if let Some(fs) = flag_sync {
        for &(uid, seen, starred) in &fs.changes {
            store::update_message_seen(&db, account, folder, uid, seen)?;
            store::update_message_starred(&db, account, folder, uid, starred)?;
        }
        if fs.highest_modseq > 0 {
            store::set_folder_modseq(&db, account, folder, fs.highest_modseq)?;
        }
    }
    store::set_folder_state(&db, account, folder, batch.uidvalidity, batch.uid_next)?;
    Ok(SyncMessagesResult {
        count,
        messages: synced_messages,
    })
}

pub(super) const DEFAULT_BACKGROUND_SYNC_TIMEOUT_SECS: u64 = 30;
pub(super) const MAX_BACKGROUND_SYNC_TIMEOUT_SECS: u64 = 24 * 60 * 60;

pub(super) fn parse_background_sync_timeout(value: Option<&str>) -> Duration {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|&secs| (1..=MAX_BACKGROUND_SYNC_TIMEOUT_SECS).contains(&secs))
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(DEFAULT_BACKGROUND_SYNC_TIMEOUT_SECS))
}

/// Per-folder sync budget, shared by background syncs and each piggybacked
/// companion sync so one slow mailbox can't hold the post-sync tail (and the
/// emit that follows it) indefinitely. The 30s default suits direct IMAP
/// servers; slow gateways (e.g. DavMail bridging Exchange EWS) can need more,
/// so it can be overridden with `MERON_SYNC_TIMEOUT` (seconds, up to one day).
pub fn background_sync_timeout() -> Duration {
    static TIMEOUT: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *TIMEOUT.get_or_init(|| {
        let value = std::env::var("MERON_SYNC_TIMEOUT").ok();
        parse_background_sync_timeout(value.as_deref())
    })
}

/// The companion mailboxes (Sent, then Drafts) to piggyback onto a sync of
/// another folder, each paired with its role label for the caller's logs.
/// Callers resolve the names via `cached_sent_folder`/`cached_drafts_folder`,
/// which already exclude the folder being synced; this only guards against the
/// two roles resolving to the same mailbox.
pub(super) fn companion_folders(
    sent: Option<String>,
    drafts: Option<String>,
) -> Vec<(&'static str, String)> {
    let mut companions = Vec::new();
    if let Some(sent) = sent {
        companions.push(("Sent", sent));
    }
    if let Some(drafts) = drafts
        && !companions
            .iter()
            .any(|(_, existing)| existing.eq_ignore_ascii_case(&drafts))
    {
        companions.push(("Drafts", drafts));
    }
    companions
}

/// Outcome of one companion-folder sync from [`sync_companion_folders`]:
/// `role` is "Sent" or "Drafts", `folder` the resolved mailbox name.
pub struct CompanionSync {
    pub role: &'static str,
    pub folder: String,
    pub result: anyhow::Result<SyncMessagesResult>,
}

/// Piggyback Sent and Drafts envelope syncs onto a completed sync of `folder`,
/// so messages sent or drafted from another client surface in the cross-folder
/// conversation view straight from the local store — the per-folder recent
/// sync only ever covers the open folder, and thread-gap filling only fetches
/// referenced *ancestors*, so nothing else ever pulls in a reply another
/// client added to Sent. Shared by desktop and mobile so the two can't drift.
/// Failures are returned per folder, never propagated: a companion hiccup must
/// not fail the primary sync that already succeeded.
pub async fn sync_companion_folders(
    engine: &Arc<Engine>,
    account: &str,
    folder: &str,
    limit: u32,
) -> Vec<CompanionSync> {
    let sent = cached_sent_folder(engine, account, folder);
    let drafts = cached_drafts_folder(engine, account, folder);
    let mut outcomes = Vec::new();
    for (role, companion) in companion_folders(sent, drafts) {
        let result = match tokio::time::timeout(
            background_sync_timeout(),
            sync_messages(engine, account, &companion, limit),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(anyhow::anyhow!("timed out")),
        };
        outcomes.push(CompanionSync {
            role,
            folder: companion,
            result,
        });
    }
    outcomes
}
