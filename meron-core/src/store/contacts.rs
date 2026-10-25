//! Recipient autocomplete from correspondents seen in the store.

use anyhow::Result;
use rusqlite::{Connection, params};

/// A correspondent surfaced for recipient autocomplete.
#[derive(serde::Serialize)]
pub struct Contact {
    pub name: String,
    pub addr: String,
}

/// Suggest contacts for recipient autocomplete, drawn from both the senders and
/// the To/Cc recipients of cached messages. Results are distinct by address and
/// ranked by how many messages the address appears on. An empty `query` returns
/// the top correspondents; otherwise we match the substring against address and
/// display name. When `account` is empty we search across all accounts (unified
/// compose).
///
/// Reads the `contacts` directory the `messages` triggers keep (see
/// `db::contacts_ddl`), matching in Rust so a name's non-ASCII case folds,
/// which SQLite's `lower()` doesn't.
pub fn suggest_contacts(
    conn: &Connection,
    account: &str,
    query: &str,
    limit: u32,
) -> Result<Vec<Contact>> {
    use std::collections::HashMap;

    let q = query.trim().to_lowercase();
    let account_filter = if account.is_empty() {
        "?1 = ''"
    } else {
        "account = ?1"
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT addr_key, addr, name, count FROM contacts WHERE {account_filter}
         ORDER BY addr_key, name"
    ))?;
    let rows = stmt.query_map(params![account], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, u32>(3)?,
        ))
    })?;

    // One entry per address, across accounts and the names it came with.
    struct Tally {
        names: Vec<(String, u32)>,
        addr: String,
        count: u32,
    }
    let mut tallies: HashMap<String, Tally> = HashMap::new();
    for row in rows {
        let (key, addr, name, count) = row?;
        // Folded again: SQLite's `lower()` leaves non-ASCII capitals alone.
        let entry = tallies.entry(key.to_lowercase()).or_insert_with(|| Tally {
            names: Vec::new(),
            addr: String::new(),
            count: 0,
        });
        entry.count += count;
        // Casing differs between rows; take one regardless of their order.
        if addr > entry.addr {
            entry.addr = addr;
        }
        if !name.is_empty() {
            match entry.names.iter_mut().find(|(seen, _)| *seen == name) {
                Some((_, seen)) => *seen += count,
                None => entry.names.push((name, count)),
            }
        }
    }

    // How well `text` holds the query: 0 at its start or a word's, 1 inside
    // a word.
    let rank = |text: &str| -> Option<u8> {
        let text = text.to_lowercase();
        let at = text.find(&q)?;
        let word_start = !text[..at]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric);
        Some(if word_start { 0 } else { 1 })
    };
    // The most frequent of `names`; ties go to the alphabetically first, for a
    // stable pick.
    let top = |names: &[&(String, u32)]| {
        names
            .iter()
            .rev()
            .max_by_key(|(_, count)| *count)
            .map(|(name, _)| name.clone())
            .unwrap_or_default()
    };
    struct Hit {
        rank: u8,
        count: u32,
        name: String,
        addr: String,
    }
    let mut hits: Vec<Hit> = tallies
        .into_values()
        .filter_map(|t| {
            let all: Vec<&(String, u32)> = t.names.iter().collect();
            if q.is_empty() {
                return Some(Hit {
                    rank: 0,
                    count: t.count,
                    name: top(&all),
                    addr: t.addr,
                });
            }
            let named: Vec<(&(String, u32), u8)> = t
                .names
                .iter()
                .filter_map(|entry| Some((entry, rank(&entry.0)?)))
                .collect();
            let name_rank = named.iter().map(|(_, rank)| *rank).min();
            if let Some(addr_rank) = rank(&t.addr) {
                return Some(Hit {
                    rank: name_rank.map_or(addr_rank, |name_rank| name_rank.min(addr_rank)),
                    count: t.count,
                    name: top(&all),
                    addr: t.addr,
                });
            }
            // Matched by name alone: rank it, and show it, by the names that
            // match. A shared sender (a notifications address carrying each
            // actor's name) mustn't outrank a person on its other names' mail.
            let matching: Vec<&(String, u32)> = named.iter().map(|(entry, _)| *entry).collect();
            Some(Hit {
                rank: name_rank?,
                count: matching.iter().map(|(_, count)| count).sum(),
                name: top(&matching),
                addr: t.addr,
            })
        })
        .collect();
    hits.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.addr.to_lowercase().cmp(&b.addr.to_lowercase()))
    });
    hits.truncate(limit as usize);
    Ok(hits
        .into_iter()
        .map(|hit| Contact {
            name: hit.name,
            addr: hit.addr,
        })
        .collect())
}
