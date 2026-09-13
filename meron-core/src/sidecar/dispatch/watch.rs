use serde_json::{Value, json};
use std::sync::Arc;

use meron_core::engine::Engine;
use meron_core::engine::*;
use meron_core::protocol::Request;

use crate::Writer;
use crate::sidecar::idle::*;
use crate::sidecar::params::*;

/// Handle IMAP IDLE watches and system resume.
pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    req: &Request,
    out: &Writer,
) -> anyhow::Result<Value> {
    let p = &req.params;
    match req.method.as_str() {
        // Start watching one account folder over IMAP IDLE. IMAP IDLE is per
        // selected mailbox, so kanban starts visible non-INBOX folders here while
        // account startup keeps INBOX watched.
        "watch.start" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            if engine.is_paused(&account) {
                return Ok(json!({ "ok": true, "paused": true }));
            }
            let started = start_idle_watch(engine.clone(), out.clone(), account, folder);
            Ok(json!({ "ok": true, "already": !started }))
        }

        "watch.stop" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let removed = engine
                .watched
                .lock()
                .unwrap()
                .remove(&watch_key(&account, &folder));
            if removed {
                engine.pause_signal.notify_waiters();
            }
            Ok(json!({ "ok": true, "stopped": removed }))
        }

        // The host OS resumed from suspend. Connections held across sleep are
        // likely dead but look fresh (monotonic clock froze), so drop pooled
        // sessions and wake every IDLE watcher to reconnect, rather than waiting
        // out TCP keepalive / the IDLE timeout with no mail being pushed.
        "system.resumed" => {
            engine.clear_all_pools();
            engine.resume_signal.notify_waiters();
            Ok(json!({ "ok": true }))
        }

        other => Err(anyhow::anyhow!("unknown method: {other}")),
    }
}
