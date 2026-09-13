use serde_json::{Value, json};
use std::sync::Arc;

use meron_core::engine::Engine;
use meron_core::engine::*;
use meron_core::protocol::Request;
use meron_core::{imap, mail_model, rss, store};

use crate::Writer;
use crate::sidecar::params::*;
use crate::sidecar::spawn::*;

/// Handle folder listing and management: `folders.*`, `messages.emptyFolder`.
pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    req: &Request,
    out: &Writer,
) -> anyhow::Result<Value> {
    let p = &req.params;
    match req.method.as_str() {
        // Cache-only (instant). When refresh != false, also kicks a background
        // sync that emits mail.synced; event-driven reloads pass refresh:false to
        // avoid a sync→event→reload loop.
        // RSS accounts return final Folder JSON (one synthetic Inbox); mail
        // returns raw rows the bridge formats. Routed by the account's engine.
        "folders.list" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                let folders = rss::folders(&engine.db.lock().unwrap(), &account)?;
                return Ok(json!({ "folders": folders }));
            }
            let folders = store::get_folders(&engine.db.lock().unwrap(), &account)?;
            if p.get("refresh").and_then(Value::as_bool).unwrap_or(true) {
                spawn_folder_sync(engine.clone(), out.clone(), account);
            }
            Ok(json!({ "folders": serde_json::to_value(folders)? }))
        }

        "folders.create" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                return Err(anyhow::anyhow!("RSS accounts do not support folders"));
            }
            let display_name = req_str(p, "name")?.trim().to_string();
            if display_name.is_empty() {
                return Err(anyhow::anyhow!("Folder name is required"));
            }
            // The user types UTF-8; servers without UTF8=ACCEPT want modified
            // UTF-7, and the wire form is what we store and address it by.
            let name = meron_core::utf7::encode(&display_name);

            engine
                .with_write_session(&account, |session| {
                    let name = name.clone();
                    Box::pin(async move { imap::create_folder(session, &name).await })
                })
                .await?;

            let folder = imap::Folder {
                name,
                display_name,
                delimiter: None,
                ..Default::default()
            };
            {
                let db = engine.db.lock().unwrap();
                store::upsert_folders(&db, &account, std::slice::from_ref(&folder))?;
            }
            Ok(json!({ "folders": serde_json::to_value(vec![folder])? }))
        }

        // Delete a folder and everything nested under it on the server, then
        // forget the whole subtree's cache. Unrecoverable, so the special-use
        // gate is re-checked here rather than trusted from the caller.
        "folders.delete" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                return Err(anyhow::anyhow!("RSS accounts do not support folders"));
            }
            let folder = canon_folder(&req_str(p, "folder").or_else(|_| req_str(p, "name"))?);
            let targets = {
                let db = engine.db.lock().unwrap();
                mail_model::check_folder_deletable(&db, &account, &folder)
                    .map_err(anyhow::Error::msg)?;
                mail_model::folder_delete_targets(&db, &account, &folder)
                    .map_err(anyhow::Error::msg)?
            };

            // EXAMINE is a read-only preflight and may retry on a stale pooled
            // socket. DELETE itself starts only after that succeeds and is
            // never retried.
            let server_result = engine
                .with_preflighted_write_session(
                    &account,
                    |session| Box::pin(imap::prepare_folder_delete(session)),
                    |session| {
                        let targets = targets.clone();
                        Box::pin(async move { imap::delete_folders(session, &targets).await })
                    },
                )
                .await;
            let (removed, warning) = match server_result {
                Ok(removed) => (removed, None),
                Err(err) => match err.downcast::<imap::PartialFolderDelete>() {
                    Ok(partial) => {
                        let (removed, warning) = partial.into_parts();
                        (removed, Some(warning))
                    }
                    Err(err) => return Err(err),
                },
            };

            let (deleted, folders) = {
                let db = engine.db.lock().unwrap();
                let mut deleted = 0;
                for target in &removed {
                    deleted += store::delete_folder(&db, &account, target)?;
                }
                (deleted, store::get_folders(&db, &account)?)
            };
            Ok(json!({
                "ok": warning.is_none(),
                "folder": folder,
                // Every folder that went with it, so the caller can clear the
                // views and caches keyed on a nested folder as well.
                "removed": removed,
                "deleted": deleted,
                "folders": serde_json::to_value(folders)?,
                "warning": warning,
            }))
        }

        "folders.archive" => {
            let account = req_str(p, "account")?;
            let archive = engine
                .with_read_session(&account, |session| {
                    Box::pin(async move { imap::find_archive_folder(session).await })
                })
                .await?;
            match archive {
                Some(folder) => Ok(json!({ "folder": folder })),
                None => Err(anyhow::anyhow!("Archive folder not found for this account")),
            }
        }

        // Permanently delete every message in a folder, server side and in the
        // store. Restricted to Trash and Junk: the operation is unrecoverable,
        // so an arbitrary folder must never reach it even if a caller asks.
        "messages.emptyFolder" => {
            let account = req_str(p, "account")?;
            let folder = canon_folder(&req_str(p, "folder")?);
            let role = {
                let db = engine.db.lock().unwrap();
                store::folder_role(&db, &account, &folder)?
            };
            if role != "trash" && role != "junk" {
                return Err(anyhow::anyhow!(
                    "Only Trash and Junk folders can be emptied"
                ));
            }

            // Mutating, so it never auto-retries.
            let expunged = engine
                .with_write_session(&account, |session| {
                    let folder = folder.clone();
                    Box::pin(async move { imap::empty_folder(session, &folder).await })
                })
                .await?;

            let deleted = {
                let db = engine.db.lock().unwrap();
                store::delete_folder_messages(&db, &account, &folder)?
            };
            mail_model::mutation_result(
                json!({
                    "ok": true,
                    "deleted": deleted,
                    "expunged": expunged,
                    "folder": folder,
                    "role": role,
                }),
                &engine.db.lock().unwrap(),
                &account,
                "",
                &folder,
                None,
                None,
                None,
                true,
            )
        }

        other => Err(anyhow::anyhow!("unknown method: {other}")),
    }
}
