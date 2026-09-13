//! Recipient autocomplete from correspondents seen in the store.

use anyhow::Result;
use rusqlite::{Connection, params};

use super::*;

/// A correspondent surfaced for recipient autocomplete.
#[derive(serde::Serialize)]
pub struct Contact {
    pub name: String,
    pub addr: String,
}

/// Suggest contacts for recipient autocomplete, drawn from both the senders and
/// the To/Cc recipients of cached messages. Results are distinct by address and
/// ranked by how often the address appears. An empty `query` returns the top
/// correspondents; otherwise we match the substring against address and display
/// name. When `account` is empty we search across all accounts (unified compose).
///
/// Recipient lists are stored as JSON, so aggregation happens in Rust rather than
/// SQL: we pull the candidate rows (coarsely pre-filtered by LIKE) and fold them
/// into a per-address tally.
pub fn suggest_contacts(
    conn: &Connection,
    account: &str,
    query: &str,
    limit: u32,
) -> Result<Vec<Contact>> {
    use std::collections::HashMap;

    let q = query.trim().to_lowercase();
    let like = format!("%{}%", escape_like(q.clone()));
    let account_filter = if account.is_empty() {
        "?1 = ''"
    } else {
        "account = ?1"
    };
    // Pre-filter: keep rows where the query appears anywhere in the sender or the
    // (JSON) recipient lists. With an empty query every row qualifies.
    let sql = format!(
        "SELECT from_name, from_addr, json_extract(json, '$.to'), json_extract(json, '$.cc')
         FROM messages
         WHERE {account_filter}
           AND uid <> 0
           AND (?2 = ''
                OR lower(COALESCE(from_addr, '')) LIKE ?3 ESCAPE '\\'
                OR lower(COALESCE(from_name, '')) LIKE ?3 ESCAPE '\\'
                OR lower(COALESCE(json_extract(json, '$.to'), '')) LIKE ?3 ESCAPE '\\'
                OR lower(COALESCE(json_extract(json, '$.cc'), '')) LIKE ?3 ESCAPE '\\')"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![account, q, like], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;

    // Tally per lowercased address: first display name seen wins (falling back to
    // a later non-empty one), plus an occurrence count for ranking.
    struct Tally {
        name: String,
        addr: String,
        count: u32,
    }
    let mut tallies: HashMap<String, Tally> = HashMap::new();
    let mut bump = |name: String, addr: String| {
        let addr = addr.trim();
        if addr.is_empty() {
            return;
        }
        let entry = tallies.entry(addr.to_lowercase()).or_insert_with(|| Tally {
            name: String::new(),
            addr: addr.to_string(),
            count: 0,
        });
        entry.count += 1;
        if entry.name.is_empty() && !name.trim().is_empty() {
            entry.name = name.trim().to_string();
        }
    };

    for row in rows {
        let (from_name, from_addr, to_json, cc_json) = row?;
        bump(from_name, from_addr);
        for json in [to_json, cc_json].into_iter().flatten() {
            if let Ok(list) = serde_json::from_str::<Vec<crate::imap::Recipient>>(&json) {
                for r in list {
                    bump(r.name, r.addr);
                }
            }
        }
    }

    // Keep only the addresses that actually match the query (the SQL pre-filter
    // admits whole rows, so a sender match can drag in non-matching recipients).
    let mut out: Vec<Tally> = tallies
        .into_values()
        .filter(|t| {
            q.is_empty() || t.addr.to_lowercase().contains(&q) || t.name.to_lowercase().contains(&q)
        })
        .collect();
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.addr.to_lowercase().cmp(&b.addr.to_lowercase()))
    });
    out.truncate(limit as usize);
    Ok(out
        .into_iter()
        .map(|t| Contact {
            name: t.name,
            addr: t.addr,
        })
        .collect())
}
