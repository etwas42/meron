use anyhow::Context as _;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

use meron_core::engine::Engine;
use meron_core::engine::*;
use meron_core::{imap, mail_model, parse, store};

use crate::{Writer, emit};

pub(crate) const IDLE_LIMIT: u32 = 50;

/// Longest a notification waits on the body fetch its snippets need. Past this
/// the event goes out with whatever bodies are cached: a late notification is
/// worse than one showing subjects alone, and the general prefetch fills the
/// rest in anyway.
pub(crate) const NOTIFY_PREVIEW_TIMEOUT: Duration = Duration::from_secs(8);

/// `mail.newMessages` detail for a batch of arrivals, with the arrivals' bodies
/// fetched first so the notification can show the mail itself.
pub(crate) async fn new_messages_detail(
    engine: &Arc<Engine>,
    account: &str,
    headers: &[imap::MessageHeader],
) -> Option<Value> {
    let uids: Vec<u32> = headers
        .iter()
        .take(mail_model::NEW_MESSAGES_DETAIL_MAX)
        .map(|header| header.uid)
        .collect();
    let fetch = fetch_bodies_for_uids(engine, account, "INBOX", &uids, parse::media_root());
    match tokio::time::timeout(NOTIFY_PREVIEW_TIMEOUT, fetch).await {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => eprintln!("meron-core: notification bodies for {account}: {err:#}"),
        Err(_) => eprintln!("meron-core: notification bodies for {account}: timed out"),
    }
    let account_name = account_label(engine, account);
    let muted = engine.is_muted(account);
    let db = engine.db.lock().unwrap();
    mail_model::new_messages_detail(&db, account, &account_name, muted, headers)
}

/// Friendly display name or email address of an account for user-facing notifications.
pub(crate) fn account_label(engine: &Arc<Engine>, account: &str) -> String {
    let db = engine.db.lock().unwrap();
    store::account_label(&db, account)
}

pub(crate) fn watch_key(account: &str, folder: &str) -> String {
    format!("{account}\n{folder}")
}

pub(crate) fn start_idle_watch(
    engine: Arc<Engine>,
    out: Writer,
    account: String,
    folder: String,
) -> bool {
    let key = watch_key(&account, &folder);
    {
        let mut watched = engine.watched.lock().unwrap();
        if watched.contains(&key) {
            return false;
        }
        watched.insert(key);
    }
    tokio::spawn(idle_watch(engine, out, account, folder));
    true
}

/// Long-lived per-account/folder IDLE watcher. Reconnects with backoff on error
/// so a dropped connection or server timeout resumes pushing updates.
pub(crate) async fn idle_watch(engine: Arc<Engine>, out: Writer, account: String, folder: String) {
    let key = watch_key(&account, &folder);
    loop {
        // Stop cleanly once the account has been removed (account.remove).
        if !engine.accounts.lock().await.contains_key(&account) {
            engine.watched.lock().unwrap().remove(&key);
            break;
        }
        // Stop checking while paused; account.setPaused respawns us on resume.
        if engine.is_paused(&account) {
            engine.watched.lock().unwrap().remove(&key);
            break;
        }
        if !engine.watched.lock().unwrap().contains(&key) {
            break;
        }
        if let Err(e) = idle_once(&engine, &out, &account, &folder).await {
            emit(
                &out,
                "error",
                json!({ "message": format!("idle {account}/{folder}: {e:#}") }),
            )
            .await;
            // Back off before reconnecting on error, but wake immediately on a
            // pause toggle so a just-paused account stops promptly (next
            // iteration sees is_paused). A clean return (pause or OS resume)
            // skips the backoff: pause exits at the top, resume reconnects now.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(15)) => {}
                _ = engine.pause_signal.notified() => {}
            }
        }
    }
    emit(
        &out,
        "watch.stopped",
        json!({ "account": account, "folder": folder }),
    )
    .await;
}

/// Sync `folder` and surface the result to the UI: a "new mail" toast when
/// INBOX's UIDNEXT advanced (genuine arrivals), otherwise a silent refresh.
/// Shared by the IDLE wake path and the post-connect catch-up so both behave
/// identically.
pub(crate) async fn sync_and_notify(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    folder: &str,
) -> anyhow::Result<()> {
    // An IDLE wake can mean new mail *or* just a flag change (e.g. a message
    // read on another device). UIDNEXT only advances for new arrivals, so
    // compare it across the refresh to tell them apart.
    let is_inbox = folder.eq_ignore_ascii_case("INBOX");
    // Refresh on a separate connection (the IDLE one stays dedicated to IDLE).
    let synced = sync_messages(engine, account, folder, IDLE_LIMIT).await?;

    let new_inbox = (!synced.arrivals.is_empty()).then_some(synced.arrivals);

    if let Some(headers) = new_inbox {
        // Building the detail fetches the arrivals' own bodies (the notification
        // shows a snippet of each); warm the rest of the backlog behind it so the
        // first open of anything else is instant too.
        let detail = new_messages_detail(engine, account, &headers).await;
        spawn_body_prefetch(engine.clone(), account.to_string(), "INBOX".to_string());
        if let Some(detail) = detail {
            emit(out, "mail.newMessages", detail).await;
        }
    } else {
        if !is_inbox {
            spawn_body_prefetch(engine.clone(), account.to_string(), folder.to_string());
        }
        // Flag-only change: refresh the UI silently, no "new mail" toast.
        emit(
            out,
            "mail.synced",
            json!({ "account": account, "folder": folder, "synced": synced.count }),
        )
        .await;
    }
    Ok(())
}

/// One IDLE connection lifecycle: hold a dedicated session on one mailbox, and
/// on each server notification refresh that folder in the store.
pub(crate) async fn idle_once(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    folder: &str,
) -> anyhow::Result<()> {
    let creds = engine.ensure_valid_creds(account).await?;
    let mut session = imap::connect(&creds).await?;
    session
        .select(folder)
        .await
        .with_context(|| format!("SELECT {folder}"))?;

    // Catch up before parking in IDLE: the server only pushes notifications for
    // mail that arrives *after* IDLE begins, so anything delivered while we were
    // disconnected (startup, error reconnect, or resume from suspend) would
    // otherwise stay invisible until the next push. Cheap because idle_once is
    // only (re)entered on a fresh connection, not on each 15-min IDLE timeout.
    sync_and_notify(engine, out, account, folder).await?;

    loop {
        let mut handle = session.idle();
        handle.init().await.context("IDLE init")?;
        enum Wake<R> {
            /// The IDLE wait completed: new data, a timeout, or an error.
            Data(R),
            /// The account was paused: return so idle_watch sees is_paused.
            Pause,
            /// The system resumed from suspend: the socket is probably dead.
            Resume,
        }
        let wake = {
            let (idle_fut, _stop) = handle.wait_with_timeout(Duration::from_secs(15 * 60));
            // Cancel the wait early on a pause (so idle_watch shuts the watcher
            // down) or an OS resume (so we drop a likely-dead socket and
            // reconnect) instead of blocking up to the IDLE timeout.
            tokio::select! {
                r = idle_fut => Wake::Data(r),
                _ = engine.pause_signal.notified() => Wake::Pause,
                _ = engine.resume_signal.notified() => Wake::Resume,
            }
        };

        // On resume the connection likely died during suspend, and a graceful
        // DONE could block on it until TCP keepalive times out. Drop the handle
        // (closing the socket) without DONE; idle_watch reconnects immediately.
        if let Wake::Resume = wake {
            drop(handle);
            return Ok(());
        }

        session = handle.done().await.context("IDLE done")?;
        let response = match wake {
            Wake::Data(r) => r,
            Wake::Pause => return Ok(()),
            Wake::Resume => unreachable!("handled above"),
        };

        if let async_imap::extensions::idle::IdleResponse::NewData(_) = response.context("IDLE")? {
            sync_and_notify(engine, out, account, folder).await?;
        }
    }
}
