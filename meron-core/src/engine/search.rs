//! Server-side mail search, with cached snapshot pages and starred search.

use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Arc;

use crate::{imap, store};

use super::*;

/// Search `account` for `query` across each of `folders` (typically Inbox +
/// Sent), merging the cached and live-IMAP hits. UIDs are folder-scoped, so
/// results are keyed by (folder, uid) and ordered newest-first by date — the
/// only ordering comparable across mailboxes. Each returned header carries its
/// source `folder` so the bridge can build per-message thread IDs correctly.
///
/// A first page resolves the complete live UID set into date order and persists
/// that order as a lightweight snapshot. Later pages walk the snapshot, so a
/// sender-controlled Date header cannot move a low UID behind an already-issued
/// cursor and transient disconnects do not invalidate an in-progress search.
pub struct SearchMailPage {
    pub messages: Vec<imap::MessageHeader>,
    pub next_cursor: Option<String>,
}

pub(super) fn cached_search_mail_page(
    conn: &Connection,
    account: &str,
    folders: &[String],
    query: &str,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> anyhow::Result<SearchMailPage> {
    let messages =
        store::search_messages_in_folders(conn, account, folders, query, limit, before_cursor)?;
    let next_cursor = store::search_next_cursor(&messages, limit, 0);
    Ok(SearchMailPage {
        messages,
        next_cursor,
    })
}

pub(super) fn record_search_folder_result(
    folder: &str,
    result: anyhow::Result<Vec<imap::MessageHeader>>,
    successes: &mut Vec<(String, Vec<imap::MessageHeader>)>,
    failures: &mut Vec<(String, String)>,
) {
    match result {
        Ok(mut headers) => {
            for header in &mut headers {
                header.folder = folder.to_string();
            }
            successes.push((folder.to_string(), headers));
        }
        Err(err) => failures.push((folder.to_string(), format!("{err:#}"))),
    }
}

pub async fn search_mail_messages(
    engine: &Arc<Engine>,
    account: &str,
    folders: &[String],
    query: &str,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> anyhow::Result<SearchMailPage> {
    if let Some(cursor) = before_cursor {
        if let Some(snapshot) = cursor.snapshot.as_deref() {
            let page = {
                let db = engine.db.lock().unwrap();
                store::get_search_snapshot_page(
                    &db,
                    account,
                    query,
                    folders,
                    snapshot,
                    cursor.offset,
                    limit,
                )?
            };
            if let Some(page) = page {
                let next_cursor =
                    snapshot_next_cursor(&page.messages, page.has_more, snapshot, page.next_offset);
                return Ok(SearchMailPage {
                    messages: page.messages,
                    next_cursor,
                });
            }
        }

        // A cache-only or expired-snapshot cursor resumes with the same keyset
        // ordering rather than accidentally querying the cache's first page.
        let db = engine.db.lock().unwrap();
        return cached_search_mail_page(&db, account, folders, query, limit, Some(cursor));
    }

    // Search folders independently on one shared session. A stale/missing Sent
    // folder must not discard a successful Inbox search (or vice versa).
    let live = engine
        .with_read_session(account, |session| {
            let folders = folders.to_vec();
            let query = query.to_string();
            Box::pin(async move {
                let mut successes = Vec::new();
                let mut failures = Vec::new();
                for folder in &folders {
                    let result = async {
                        let uids = imap::search_uids(session, folder, &query).await?;
                        let mut headers = Vec::with_capacity(uids.len());
                        for chunk in uids.chunks(500) {
                            headers
                                .extend(imap::fetch_headers_by_uid(session, folder, chunk).await?);
                        }
                        anyhow::Ok(headers)
                    }
                    .await;
                    record_search_folder_result(folder, result, &mut successes, &mut failures);
                }
                anyhow::Ok((successes, failures))
            })
        })
        .await;

    let (per_folder, failures) = match live {
        Ok(result) => result,
        Err(err) => {
            crate::mlog!(
                crate::log::Level::Warn,
                "mail.search",
                "live search failed for account={account}: {err:#}"
            );
            (Vec::new(), Vec::new())
        }
    };
    if !failures.is_empty() {
        // The operation deliberately preserved successful folders, so the pool
        // saw an overall success. Do not retain a socket that may have produced
        // an I/O failure partway through the per-folder loop.
        engine.clear_pool(account);
    }
    for (folder, error) in failures {
        crate::mlog!(
            crate::log::Level::Warn,
            "mail.search",
            "live search failed for account={account} folder={folder}: {error}"
        );
    }

    if per_folder.is_empty() {
        let db = engine.db.lock().unwrap();
        return cached_search_mail_page(&db, account, folders, query, limit, None);
    }

    let mut by_key: HashMap<(String, u32), imap::MessageHeader> = HashMap::new();
    {
        let db = engine.db.lock().unwrap();
        for (folder, headers) in &per_folder {
            store::upsert_messages(&db, account, folder, headers)?;
        }
        for message in
            store::search_messages_in_folders(&db, account, folders, query, u32::MAX, None)?
        {
            by_key.insert((message.folder.clone(), message.uid), message);
        }
    }
    for (folder, headers) in per_folder {
        for message in headers {
            by_key.insert((folder.clone(), message.uid), message);
        }
    }
    let mut all_messages = by_key.into_values().collect::<Vec<_>>();
    store::sort_search_hits_all(&mut all_messages);
    let token = {
        let db = engine.db.lock().unwrap();
        store::save_search_snapshot(&db, account, query, folders, &all_messages)?
    };
    let has_more = all_messages.len() > limit as usize;
    let mut messages = all_messages;
    messages.truncate(limit as usize);
    let next_cursor = snapshot_next_cursor(&messages, has_more, &token, messages.len() as u32);
    Ok(SearchMailPage {
        messages,
        next_cursor,
    })
}

pub(super) fn snapshot_next_cursor(
    messages: &[imap::MessageHeader],
    has_more: bool,
    snapshot: &str,
    offset: u32,
) -> Option<String> {
    let header = has_more.then(|| messages.last()).flatten()?;
    Some(crate::thread_list::format_search_cursor(
        &crate::thread_list::SearchCursor {
            date: header.date,
            uid: header.uid,
            folder: header.folder.clone(),
            scanned: 0,
            snapshot: Some(snapshot.to_string()),
            offset,
        },
    ))
}

pub async fn starred_search_folders(
    engine: &Arc<Engine>,
    account: &str,
    requested: &str,
) -> Vec<String> {
    let is_gmail = {
        let accounts = engine.accounts.lock().await;
        accounts
            .get(account)
            .map(|creds| creds.auth_type == "gmail_oauth")
            .unwrap_or(false)
    };
    eprintln!(
        "meron-core: starred folders account={account} requested={requested} gmail={is_gmail}"
    );
    if !is_gmail {
        return vec![requested.to_string()];
    }
    let mut folders = store::get_folders(&engine.db.lock().unwrap(), account).unwrap_or_default();
    let find_starred = |folders: &[imap::Folder]| {
        folders
            .iter()
            .map(|folder| folder.name.as_str())
            .find(|name| {
                name.eq_ignore_ascii_case("starred")
                    || name.eq_ignore_ascii_case("[gmail]/starred")
                    || name.eq_ignore_ascii_case("[google mail]/starred")
            })
            .map(str::to_string)
    };
    eprintln!(
        "meron-core: starred folders cached_count={} account={account}",
        folders.len()
    );
    if let Some(folder) = find_starred(&folders) {
        eprintln!("meron-core: starred folders using_starred_mailbox={folder}");
        return vec![folder];
    }
    let fresh = engine
        .with_read_session(account, |session| {
            Box::pin(async move { imap::list_folders(session).await })
        })
        .await;
    match fresh {
        Ok(fresh) => {
            eprintln!(
                "meron-core: starred folders fresh_count={} account={account}",
                fresh.len()
            );
            if let Ok(db) = engine.db.lock() {
                let _ = store::upsert_folders(&db, account, &fresh);
            }
            folders = fresh;
            if let Some(folder) = find_starred(&folders) {
                eprintln!("meron-core: starred folders using_starred_mailbox={folder}");
                return vec![folder];
            }
        }
        Err(err) => {
            eprintln!("meron-core: starred folders LIST/connect failed account={account}: {err:#}");
        }
    }
    let mut names = folders
        .into_iter()
        .map(|folder| folder.name)
        .collect::<Vec<_>>();
    if names.is_empty() {
        names.push(requested.to_string());
    }
    eprintln!(
        "meron-core: starred folders scan_count={} names={}",
        names.len(),
        names.join(", ")
    );
    names
}

pub async fn search_starred_mail_messages(
    engine: &Arc<Engine>,
    account: &str,
    folders: &[String],
    limit: u32,
    refresh: bool,
) -> anyhow::Result<Vec<imap::MessageHeader>> {
    let mut by_uid = HashMap::new();
    let mut cached_count = 0usize;
    for folder in folders {
        let cached = store::get_starred(&engine.db.lock().unwrap(), account, folder, limit)?;
        cached_count += cached.len();
        for message in cached {
            by_uid.insert(format!("{folder}:{}", message.uid), message);
        }
    }
    eprintln!(
        "meron-core: starred search account={account} folders={} cached_hits={} refresh={refresh}",
        folders.len(),
        cached_count
    );

    if refresh {
        // Best-effort per folder: a single folder's failure is logged and
        // skipped, so the closure always succeeds (no stale-retry needed here).
        let server_headers = engine
            .with_read_session(account, |session| {
                let folders = folders.to_vec();
                Box::pin(async move {
                    let mut headers = Vec::new();
                    for folder in &folders {
                        let result = async {
                            let uids = imap::search_starred_uids(session, folder, limit).await?;
                            imap::fetch_headers_by_uid(session, folder, &uids).await
                        }
                        .await;
                        if let Ok(mut found) = result {
                            eprintln!(
                                "meron-core: starred search folder={folder} hits={}",
                                found.len()
                            );
                            for header in &mut found {
                                header.folder = folder.to_string();
                                header.starred = true;
                            }
                            headers.extend(found);
                        } else if let Err(err) = result {
                            eprintln!("meron-core: starred search folder={folder} failed: {err:#}");
                        }
                    }
                    anyhow::Ok(headers)
                })
            })
            .await
            .map_err(|err| {
                eprintln!("meron-core: starred search connect failed account={account}: {err:#}");
                err
            })
            .ok();

        if let Some(headers) = server_headers {
            {
                let db = engine.db.lock().unwrap();
                let mut by_folder: HashMap<String, Vec<imap::MessageHeader>> = HashMap::new();
                for header in &headers {
                    by_folder
                        .entry(header.folder.clone())
                        .or_default()
                        .push(header.clone());
                }
                for (folder, headers) in by_folder {
                    store::upsert_messages(&db, account, &folder, &headers)?;
                }
            }
            for message in headers {
                by_uid.insert(format!("{}:{}", message.folder, message.uid), message);
            }
        }
    }

    let mut messages = by_uid.into_values().collect::<Vec<_>>();
    messages.sort_unstable_by(|a, b| b.date.cmp(&a.date).then_with(|| b.uid.cmp(&a.uid)));
    messages.truncate(limit as usize);
    eprintln!(
        "meron-core: starred search account={account} returning={}",
        messages.len()
    );
    Ok(messages)
}
