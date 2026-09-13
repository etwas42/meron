//! Local message search and saved search snapshot pages.

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::imap::MessageHeader;

use super::*;

/// Flatten `To`/`Cc` into the plain text `messages.recipients` indexes. The
/// recipient lists themselves live in the `json` catch-all, which FTS can't
/// reach, so this mirror is what makes "find the mail I sent to Ann" work
/// against the cache. `None` for a message with no addressees, which the write
/// path treats as "leave whatever is already indexed alone".
pub(super) fn recipients_index_text(
    to: &[crate::imap::Recipient],
    cc: &[crate::imap::Recipient],
) -> Option<String> {
    let text = to
        .iter()
        .chain(cc.iter())
        .map(|recipient| {
            format!("{} {}", recipient.name, recipient.addr)
                .trim()
                .to_string()
        })
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    (!text.is_empty()).then_some(text)
}

/// Substring search over one folder's cached messages, newest first.
///
/// `before_cursor` is the `(date, uid, folder)` of the last row of the previous
/// page. The folder tie-breaker is required because UIDs are mailbox-scoped.
pub fn search_messages(
    conn: &Connection,
    account: &str,
    folder: &str,
    query: &str,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> Result<Vec<MessageHeader>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // The trigram index needs >= 3 codepoints; serve shorter queries (common for
    // CJK, where words are often 2 characters) with the scoped LIKE scan instead.
    if q.chars().count() < 3 {
        return search_messages_like(conn, account, folder, q, limit, before_cursor);
    }
    // Whole query as one quoted FTS phrase -> trigram substring match (doubling
    // any `"` so user input can't change the query). Same substring semantics as
    // the LIKE path, just index-backed. Both indexes answer the same phrase: the
    // body/subject/sender one and the recipients one.
    let match_query = format!("\"{}\"", q.replace('"', "\"\""));
    let cursor_date = before_cursor.map(|cursor| cursor.date);
    let cursor_uid = before_cursor.map(|cursor| cursor.uid as i64).unwrap_or(0);
    let cursor_folder = before_cursor.map(|cursor| cursor.folder.as_str());
    let mut stmt = conn.prepare(
        "SELECT m.uid, m.subject, m.from_name, m.from_addr, m.date, m.seen, m.starred,
                m.thread_key, json_extract(m.json, '$.to'),
                COALESCE(json_extract(m.json, '$.message_id'), '')
         FROM messages m
         WHERE m.id IN (
                 SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1
                 UNION
                 SELECT rowid FROM messages_recipients_fts WHERE messages_recipients_fts MATCH ?1
               )
           AND m.account = ?2 AND m.folder = ?3 AND m.uid <> 0
           AND (?5 IS NULL
                OR m.date < ?5
                OR (m.date = ?5 AND m.uid < ?6)
                OR (m.date = ?5 AND m.uid = ?6 AND m.folder < ?7))
         ORDER BY m.date DESC, m.uid DESC LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![
            match_query,
            account,
            folder,
            limit,
            cursor_date,
            cursor_uid,
            cursor_folder
        ],
        search_header_from_row,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Substring search via a scoped table scan. Used for queries too short for the
/// trigram FTS index (< 3 codepoints).
pub(super) fn search_messages_like(
    conn: &Connection,
    account: &str,
    folder: &str,
    q: &str,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> Result<Vec<MessageHeader>> {
    let like = format!("%{}%", escape_like(q.to_lowercase()));
    let cursor_date = before_cursor.map(|cursor| cursor.date);
    let cursor_uid = before_cursor.map(|cursor| cursor.uid as i64).unwrap_or(0);
    let cursor_folder = before_cursor.map(|cursor| cursor.folder.as_str());
    let mut stmt = conn.prepare(
        "SELECT uid, subject, from_name, from_addr, date, seen, starred, thread_key,
                json_extract(json, '$.to'),
                COALESCE(json_extract(json, '$.message_id'), '') FROM messages
         WHERE account = ?1 AND folder = ?2 AND uid <> 0
           AND (
             lower(COALESCE(subject, '')) LIKE ?3 ESCAPE '\\'
             OR lower(COALESCE(from_name, '')) LIKE ?3 ESCAPE '\\'
             OR lower(COALESCE(from_addr, '')) LIKE ?3 ESCAPE '\\'
             OR lower(COALESCE(recipients, '')) LIKE ?3 ESCAPE '\\'
             OR lower(COALESCE(body, '')) LIKE ?3 ESCAPE '\\'
           )
           AND (?5 IS NULL
                OR date < ?5
                OR (date = ?5 AND uid < ?6)
                OR (date = ?5 AND uid = ?6 AND folder < ?7))
         ORDER BY date DESC, uid DESC LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![
            account,
            folder,
            like,
            limit,
            cursor_date,
            cursor_uid,
            cursor_folder
        ],
        search_header_from_row,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Search several folders (typically the open mailbox plus Sent) as one
/// newest-first result set. UIDs are folder-scoped, so each header carries the
/// folder it came from and ordering is by date — the only key comparable across
/// mailboxes. Used both for the cached half of a live search and, on mobile, as
/// the whole answer when the server can't be reached.
pub fn search_messages_in_folders(
    conn: &Connection,
    account: &str,
    folders: &[String],
    query: &str,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> Result<Vec<MessageHeader>> {
    let mut messages = Vec::new();
    for folder in folders {
        for mut message in search_messages(conn, account, folder, query, limit, before_cursor)? {
            message.folder = folder.clone();
            messages.push(message);
        }
    }
    sort_search_hits(&mut messages, limit);
    Ok(messages)
}

/// Newest first by epoch send time, capped at `limit`; unknown dates (0) sort
/// last. Shared by every path that merges search hits from more than one source
/// so cached-only and cached+live results are ordered identically.
pub fn sort_search_hits(messages: &mut Vec<MessageHeader>, limit: u32) {
    sort_search_hits_all(messages);
    messages.truncate(limit as usize);
}

pub fn sort_search_hits_all(messages: &mut [MessageHeader]) {
    messages.sort_unstable_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| b.uid.cmp(&a.uid))
            .then_with(|| b.folder.cmp(&a.folder))
    });
}

/// The search cursor for the page after `messages`, or `None` when
/// this page was short (a short page means the result set is exhausted).
pub fn search_next_cursor(messages: &[MessageHeader], limit: u32, scanned: u32) -> Option<String> {
    if messages.len() < limit as usize {
        return None;
    }
    messages.last().map(|header| {
        crate::thread_list::format_search_cursor(&crate::thread_list::SearchCursor {
            date: header.date,
            uid: header.uid,
            folder: header.folder.clone(),
            scanned,
            snapshot: None,
            offset: 0,
        })
    })
}

pub struct SearchSnapshotPage {
    pub messages: Vec<MessageHeader>,
    pub next_offset: u32,
    pub has_more: bool,
}

/// Persist the resolved order of one live IMAP search. Only identities and
/// positions are stored; headers remain in `messages`, where the live fetch
/// already upserted them.
pub fn save_search_snapshot(
    conn: &Connection,
    account: &str,
    query: &str,
    folders: &[String],
    messages: &[MessageHeader],
) -> Result<String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let scope = serde_json::to_string(folders)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let tx = conn.unchecked_transaction()?;
    for (position, message) in messages.iter().enumerate() {
        tx.execute(
            "INSERT INTO mail_search_hits(
               token, account, query, scope, position, folder, uid, created_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                token,
                account,
                query,
                scope,
                position as i64,
                message.folder,
                message.uid,
                created_at
            ],
        )?;
    }
    // Search snapshots are disposable cache state. A one-day lease is long
    // enough for suspended mobile views to resume without letting abandoned
    // queries grow the database indefinitely.
    tx.execute(
        "DELETE FROM mail_search_hits
         WHERE account = ?1 AND created_at < ?2",
        params![account, created_at.saturating_sub(86_400)],
    )?;
    tx.commit()?;
    Ok(token)
}

/// Read a stable live-search page. `None` means the cursor is stale or belongs
/// to a different query/scope, in which case callers can resume keyset paging
/// through ordinary cached search results.
pub fn get_search_snapshot_page(
    conn: &Connection,
    account: &str,
    query: &str,
    folders: &[String],
    token: &str,
    offset: u32,
    limit: u32,
) -> Result<Option<SearchSnapshotPage>> {
    let scope = serde_json::to_string(folders)?;
    let exists = conn
        .query_row(
            "SELECT 1 FROM mail_search_hits
             WHERE token = ?1 AND account = ?2 AND query = ?3 AND scope = ?4
             LIMIT 1",
            params![token, account, query, scope],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(None);
    }

    let fetch_limit = limit.saturating_add(1);
    let mut stmt = conn.prepare(
        "SELECT m.uid, m.subject, m.from_name, m.from_addr, m.date, m.seen, m.starred,
                m.thread_key, json_extract(m.json, '$.to'), h.folder, h.position,
                COALESCE(json_extract(m.json, '$.message_id'), '')
         FROM mail_search_hits h
         JOIN messages m
           ON m.account = h.account AND m.folder = h.folder AND m.uid = h.uid
         WHERE h.token = ?1 AND h.account = ?2 AND h.query = ?3 AND h.scope = ?4
           AND h.position >= ?5
         ORDER BY h.position
         LIMIT ?6",
    )?;
    let rows = stmt.query_map(
        params![token, account, query, scope, offset, fetch_limit],
        |row| {
            let mut message = message_header_from_row(row)?;
            message.folder = row.get(9)?;
            message.message_id = row.get(11)?;
            Ok((message, row.get::<_, u32>(10)?))
        },
    )?;
    let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit as usize;
    if has_more {
        rows.pop();
    }
    let next_offset = rows
        .last()
        .map(|(_, position)| position.saturating_add(1))
        .unwrap_or(offset);
    Ok(Some(SearchSnapshotPage {
        messages: rows.into_iter().map(|(message, _)| message).collect(),
        next_offset,
        has_more,
    }))
}
