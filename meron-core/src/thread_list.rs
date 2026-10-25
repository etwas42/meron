//! Shared mailbox listing for both frontends. Desktop (`messages.recent` in the
//! sidecar) and mobile (`mail.threadList` over FFI) answer the same question —
//! which cards belong in this mailbox view — and differ only in how they reach a
//! page of headers: desktop may go live over IMAP, mobile answers from the
//! encrypted cache so the list still works offline. The view's inputs, the
//! filter-to-source decision and the response shape live here so a fix for one
//! frontend is a fix for both; platform callers keep only the fetch itself and
//! whatever background sync they spawn afterwards.

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::Connection;
use serde_json::{Value, json};

use crate::imap::MessageHeader;
use crate::{mail_model, rss, store};

/// Default page size when a caller does not ask for one.
pub const DEFAULT_LIMIT: u32 = 50;

/// How many further pages a request reads when the attachments toggle empties
/// the one it asked for (see [`ThreadListQuery::next_attachment_cursor`]).
/// Bounded so a long mailbox with no attachments answers in a few reads, not a
/// walk of the whole folder (a live search pays a server round-trip per page).
/// Past the bound the empty page still carries its cursor, and both frontends
/// offer "Load more" on an empty list that has one.
pub const ATTACHMENT_PAGE_HOPS: u32 = 5;

/// The mailbox-view inputs, as both transports send them. Only the folder key
/// differs between the two param vocabularies ("folder" vs "folder_id").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadListQuery {
    pub folder: String,
    pub query: String,
    pub filter: String,
    /// Keep only threads with attachments. Independent of `filter`, so it
    /// combines with unread and starred.
    pub attachments: bool,
    pub before_cursor: Option<(i64, u32)>,
    pub search_before_cursor: Option<SearchCursor>,
    pub limit: u32,
}

/// A globally ordered search position. UIDs are only unique within a folder, so
/// the folder is the final key when Inbox and Sent are merged into one page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchCursor {
    pub date: i64,
    pub uid: u32,
    pub folder: String,
    /// Legacy progressive-scan position, retained so an in-flight cursor minted
    /// by the previous release can fall back to cached keyset paging.
    pub scanned: u32,
    /// Stable live-result snapshot and next position. Absent on cache-only
    /// cursors and cursors minted by versions before search snapshots.
    pub snapshot: Option<String>,
    pub offset: u32,
}

impl ThreadListQuery {
    pub fn from_params(params: &Value, folder_key: &str) -> Self {
        let folder = params
            .get(folder_key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(mail_model::canon_folder)
            .unwrap_or_else(|| "INBOX".to_string());
        Self {
            folder,
            query: params
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            filter: params
                .get("filter")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            attachments: params
                .get("attachments")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            before_cursor: params
                .get("before_cursor")
                .and_then(Value::as_str)
                .and_then(parse_mail_cursor),
            search_before_cursor: params
                .get("before_cursor")
                .and_then(Value::as_str)
                .and_then(parse_search_cursor),
            limit: params
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|limit| u32::try_from(limit).ok())
                .filter(|limit| *limit > 0)
                .unwrap_or(DEFAULT_LIMIT),
        }
    }

    /// Which page the (filter, query) pair asks for.
    pub fn source(&self) -> MailSource {
        if !self.query.is_empty() {
            return MailSource::Search;
        }
        match self.filter.as_str() {
            "starred" => MailSource::Starred,
            filter => MailSource::Recent {
                filter: store::RecentFilter {
                    unread_only: filter == "unread",
                    attachments_only: self.attachments,
                },
            },
        }
    }

    /// The cursor to read on from when the attachments toggle left `page` with
    /// no threads but more to come, and `hops` further pages have already been
    /// read for this request. `None` means `page` is the answer.
    pub fn next_attachment_cursor(&self, page: &Value, hops: u32) -> Option<String> {
        if !self.attachments || hops >= ATTACHMENT_PAGE_HOPS {
            return None;
        }
        let empty = page
            .get("threads")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        if !empty {
            return None;
        }
        page.get("next_cursor")
            .and_then(Value::as_str)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_string)
    }

    /// Apply the attachments toggle to a finished page's `threads`. The cached
    /// recent page is already narrowed in SQL (so its cursor stays exact); the
    /// other sources — search, starred, feeds — are narrowed here, card by card.
    pub fn retain_attachment_threads(&self, page: &mut Value) {
        if !self.attachments {
            return;
        }
        if let Some(threads) = page.get_mut("threads").and_then(Value::as_array_mut) {
            threads.retain(|thread| {
                thread
                    .get("has_attachments")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            });
        }
    }

    /// Whether this request should also kick off a server sync: only the first
    /// page of an unfiltered, unsearched view — the other sources are answered
    /// by their own live call or are cheap local reads.
    pub fn wants_background_sync(&self) -> bool {
        self.before_cursor.is_none() && matches!(self.source(), MailSource::Recent { .. })
    }
}

/// Where a mail page comes from. Both frontends map filters to the same source;
/// what each source *reads* (live IMAP vs the local cache) is theirs to decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailSource {
    /// Starred-only view, unpaginated.
    Starred,
    /// Newest-first cached page, cursor paged, optionally narrowed to unread
    /// mail or mail with attachments.
    Recent { filter: store::RecentFilter },
    /// Text search across the folder plus Sent, cursor-paginated.
    Search,
}

/// `date:<date>:<uid>` keyset cursor, as minted by [`store::get_recent_page`].
pub fn parse_mail_cursor(cursor: &str) -> Option<(i64, u32)> {
    let rest = cursor.strip_prefix("date:")?;
    let (date, uid) = rest.split_once(':')?;
    Some((date.parse().ok()?, uid.parse().ok()?))
}

/// `search:<date>:<uid>:<scanned>:<base64-folder>` cursor for a merged page.
pub fn parse_search_cursor(cursor: &str) -> Option<SearchCursor> {
    if let Some(rest) = cursor.strip_prefix("search2:") {
        let mut parts = rest.splitn(5, ':');
        let date = parts.next()?.parse().ok()?;
        let uid = parts.next()?.parse().ok()?;
        let offset = parts.next()?.parse().ok()?;
        let snapshot = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
        let folder = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
        return Some(SearchCursor {
            date,
            uid,
            folder,
            scanned: 0,
            snapshot: Some(snapshot),
            offset,
        });
    }
    let rest = cursor.strip_prefix("search:")?;
    let mut parts = rest.splitn(4, ':');
    let date = parts.next()?.parse().ok()?;
    let uid = parts.next()?.parse().ok()?;
    let scanned = parts.next()?.parse().ok()?;
    let folder = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
    Some(SearchCursor {
        date,
        uid,
        folder,
        scanned,
        snapshot: None,
        offset: 0,
    })
}

pub fn format_search_cursor(cursor: &SearchCursor) -> String {
    if let Some(snapshot) = &cursor.snapshot {
        return format!(
            "search2:{}:{}:{}:{}:{}",
            cursor.date,
            cursor.uid,
            cursor.offset,
            URL_SAFE_NO_PAD.encode(snapshot.as_bytes()),
            URL_SAFE_NO_PAD.encode(cursor.folder.as_bytes())
        );
    }
    format!(
        "search:{}:{}:{}:{}",
        cursor.date,
        cursor.uid,
        cursor.scanned,
        URL_SAFE_NO_PAD.encode(cursor.folder.as_bytes())
    )
}

/// Feed accounts: one card per subscription, filtered like a mail folder.
pub fn rss_page(conn: &Connection, account: &str, query: &ThreadListQuery) -> Result<Value> {
    let threads = rss::recent(
        conn,
        account,
        &query.query,
        &query.filter,
        query.limit as i64,
    )?;
    let folder_unread = rss::unread_count(conn, account)?;
    let mut page = json!({ "threads": threads, "folder_unread": folder_unread });
    query.retain_attachment_threads(&mut page);
    Ok(page)
}

/// Mail accounts: shape a fetched header page into the bridge payload.
///
/// `group` is what thread-list callers want — core grouping (subject branching,
/// root titles, accumulated unread counts) into ready cards. Other consumers
/// (mobile is always a thread list; the desktop chat view is not) keep the raw
/// rows under "messages".
pub fn mail_page(
    conn: &Connection,
    account: &str,
    folder: &str,
    mut messages: Vec<MessageHeader>,
    next_cursor: Option<String>,
    group: bool,
) -> Result<Value> {
    // Rewrite each card's identity to the correspondent so a thread shows the
    // same person/avatar in every folder (outbound copies show the recipient).
    store::apply_card_identity(conn, account, folder, &mut messages);
    let folder_unread = store::get_folder_unread(conn, account, folder)?;
    // A folder row can exist before its first header sync. Keep that distinct
    // from a completed sync that found no messages.
    let folder_synced = store::get_folder_state(conn, account, folder)?.is_some();
    let mut out = if group {
        let draft_thread_keys = store::draft_thread_keys(conn, account)?;
        let threads =
            mail_model::thread_cards_json(conn, account, folder, messages, &draft_thread_keys)?;
        json!({ "threads": threads, "folder_unread": folder_unread, "folder_synced": folder_synced })
    } else {
        json!({
            "messages": serde_json::to_value(messages)?,
            "folder_unread": folder_unread,
            "folder_synced": folder_synced,
        })
    };
    if let Some(cursor) = next_cursor {
        out.as_object_mut()
            .unwrap()
            .insert("next_cursor".to_string(), Value::String(cursor));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_pick_the_same_source_for_both_frontends() {
        let query = |params: Value| ThreadListQuery::from_params(&params, "folder");
        let recent = |unread_only, attachments_only| MailSource::Recent {
            filter: store::RecentFilter {
                unread_only,
                attachments_only,
            },
        };
        assert_eq!(
            query(json!({"filter": "all"})).source(),
            recent(false, false)
        );
        assert_eq!(
            query(json!({"filter": "unread"})).source(),
            recent(true, false)
        );
        // The attachments toggle combines with the read-state filter.
        assert_eq!(
            query(json!({"filter": "unread", "attachments": true})).source(),
            recent(true, true)
        );
        assert_eq!(
            query(json!({"filter": "starred"})).source(),
            MailSource::Starred
        );
        // A search wins over any filter: the source has no filtered variant.
        assert_eq!(
            query(json!({"filter": "starred", "query": "hello"})).source(),
            MailSource::Search
        );
        // A blank search is not a search.
        assert_eq!(
            query(json!({"query": "   "})).source(),
            recent(false, false)
        );
    }

    #[test]
    fn attachments_toggle_reads_on_past_emptied_pages() {
        let on = ThreadListQuery::from_params(&json!({"attachments": true}), "folder");
        let off = ThreadListQuery::from_params(&json!({}), "folder");
        let empty = json!({"threads": [], "next_cursor": "date:1:2"});
        assert_eq!(
            on.next_attachment_cursor(&empty, 0).as_deref(),
            Some("date:1:2")
        );
        // Without the toggle an empty page is the folder's own answer.
        assert_eq!(off.next_attachment_cursor(&empty, 0), None);
        // A page with matches, or the last page, is the answer.
        let found = json!({"threads": [{"id": "t"}], "next_cursor": "date:1:2"});
        assert_eq!(on.next_attachment_cursor(&found, 0), None);
        assert_eq!(on.next_attachment_cursor(&json!({"threads": []}), 0), None);
        // And the walk is bounded.
        assert_eq!(
            on.next_attachment_cursor(&empty, ATTACHMENT_PAGE_HOPS),
            None
        );
    }

    #[test]
    fn attachments_toggle_narrows_finished_pages() {
        let mut page = json!({"threads": [
            {"id": "plain", "has_attachments": false},
            {"id": "files", "has_attachments": true},
            {"id": "feed"},
        ]});
        let off = ThreadListQuery::from_params(&json!({}), "folder");
        off.retain_attachment_threads(&mut page);
        assert_eq!(page["threads"].as_array().unwrap().len(), 3);

        let on = ThreadListQuery::from_params(&json!({"attachments": true}), "folder");
        on.retain_attachment_threads(&mut page);
        assert_eq!(
            page["threads"],
            json!([{"id": "files", "has_attachments": true}])
        );
    }

    #[test]
    fn params_default_to_the_inbox_and_the_default_page_size() {
        let bare = ThreadListQuery::from_params(&json!({}), "folder_id");
        assert_eq!(bare.folder, "INBOX");
        assert_eq!(bare.limit, DEFAULT_LIMIT);
        assert!(bare.before_cursor.is_none());
        assert!(bare.wants_background_sync());

        let full = ThreadListQuery::from_params(
            &json!({"folder_id": "inbox", "limit": 10, "before_cursor": "date:200:7"}),
            "folder_id",
        );
        assert_eq!(full.folder, "INBOX", "folder names are canonicalized");
        assert_eq!(full.limit, 10);
        assert_eq!(full.before_cursor, Some((200, 7)));
        assert!(full.search_before_cursor.is_none());
        assert!(
            !full.wants_background_sync(),
            "paging older never triggers a sync"
        );
    }

    #[test]
    fn search_cursor_round_trips_folder_names() {
        let cursor = SearchCursor {
            date: 200,
            uid: 7,
            folder: "Sent: 日本語".to_string(),
            scanned: 50,
            snapshot: None,
            offset: 0,
        };
        assert_eq!(
            parse_search_cursor(&format_search_cursor(&cursor)),
            Some(cursor.clone())
        );
        let snapshot_cursor = SearchCursor {
            scanned: 0,
            snapshot: Some("opaque token".to_string()),
            offset: 50,
            ..cursor
        };
        assert_eq!(
            parse_search_cursor(&format_search_cursor(&snapshot_cursor)),
            Some(snapshot_cursor)
        );
    }

    #[test]
    fn only_unfiltered_first_pages_ask_for_a_sync() {
        let query = |params: Value| ThreadListQuery::from_params(&params, "folder");
        assert!(query(json!({"filter": "unread"})).wants_background_sync());
        assert!(!query(json!({"filter": "starred"})).wants_background_sync());
        assert!(!query(json!({"query": "hello"})).wants_background_sync());
    }
}
