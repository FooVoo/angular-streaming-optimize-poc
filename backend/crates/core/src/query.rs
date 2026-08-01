//! Filter + sort as an index permutation.
//!
//! Nothing here ever copies a row. A query produces a `Vec<u32>` of row indices;
//! sorting permutes that vector. This is the same discipline the browser worker
//! uses on its `Uint32Array` — copying 3M rows per sort is the classic way to
//! turn a 40 ms operation into a 4 s one.

use rayon::prelude::*;
use serde::Serialize;

use crate::store::{ColumnStore, STATUS};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SortKey {
    Id,
    CreatedAt,
    Title,
    Category,
    Status,
    Price,
    Qty,
    Active,
}

impl SortKey {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "id" => Self::Id,
            "created_at" => Self::CreatedAt,
            "title" => Self::Title,
            "category" => Self::Category,
            "status" => Self::Status,
            "price" => Self::Price,
            "qty" => Self::Qty,
            "active" => Self::Active,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct Query {
    /// Case-insensitive substring match against the title dictionary.
    pub q: Option<String>,
    pub status: Option<u8>,
    pub category: Option<u16>,
    pub active: Option<bool>,
    pub min_price: Option<f64>,
    pub max_price: Option<f64>,
    pub sort: Option<SortKey>,
    pub desc: bool,
}

impl Query {
    pub fn is_unfiltered(&self) -> bool {
        self.q.is_none()
            && self.status.is_none()
            && self.category.is_none()
            && self.active.is_none()
            && self.min_price.is_none()
            && self.max_price.is_none()
    }

    /// Stable identity for the query cache. Floats go in by bit pattern, which is
    /// correct here because the value came from a string parse — the same request
    /// string always yields the same bits.
    pub fn cache_key(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.q.hash(&mut h);
        self.status.hash(&mut h);
        self.category.hash(&mut h);
        self.active.hash(&mut h);
        self.min_price.map(f64::to_bits).hash(&mut h);
        self.max_price.map(f64::to_bits).hash(&mut h);
        self.sort.map(|s| s as u8).hash(&mut h);
        self.desc.hash(&mut h);
        h.finish()
    }
}

/// Which dictionary entries match the text needle. Computed over 50k dictionary
/// strings, not 3M rows — the row scan then compares integers.
fn matching_titles(store: &ColumnStore, needle: &str) -> Vec<bool> {
    let needle = needle.to_lowercase();
    store
        .title_dict
        .par_iter()
        .map(|t| t.to_lowercase().contains(&needle))
        .collect()
}

pub fn select(store: &ColumnStore, query: &Query) -> Vec<u32> {
    let title_hits = query
        .q
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|n| matching_titles(store, n));

    let mut idx: Vec<u32> = if title_hits.is_none() && query.is_unfiltered() {
        (0..store.len as u32).collect()
    } else {
        (0..store.len as u32)
            .into_par_iter()
            .filter(|&i| {
                let i = i as usize;
                if let Some(hits) = &title_hits
                    && !hits[store.title_idx[i] as usize]
                {
                    return false;
                }
                if let Some(s) = query.status
                    && store.status[i] != s
                {
                    return false;
                }
                if let Some(c) = query.category
                    && store.category_idx[i] != c
                {
                    return false;
                }
                if let Some(a) = query.active
                    && store.active[i] != a
                {
                    return false;
                }
                if let Some(min) = query.min_price
                    && store.price[i] < min
                {
                    return false;
                }
                if let Some(max) = query.max_price
                    && store.price[i] > max
                {
                    return false;
                }
                true
            })
            .collect()
    };

    if let Some(key) = query.sort {
        sort_indices(store, &mut idx, key, query.desc);
    }
    idx
}

fn sort_indices(store: &ColumnStore, idx: &mut [u32], key: SortKey, desc: bool) {
    // `id` is already the natural order for an unfiltered ascending scan.
    if key == SortKey::Id && !desc && idx.len() == store.len {
        return;
    }
    match key {
        SortKey::Id => idx.par_sort_unstable_by_key(|&i| store.id[i as usize]),
        SortKey::CreatedAt => idx.par_sort_unstable_by_key(|&i| store.created_at[i as usize]),
        SortKey::Title => idx
            .par_sort_unstable_by_key(|&i| store.title_rank[store.title_idx[i as usize] as usize]),
        SortKey::Category => idx.par_sort_unstable_by_key(|&i| store.category_idx[i as usize]),
        SortKey::Status => idx.par_sort_unstable_by_key(|&i| store.status[i as usize]),
        SortKey::Qty => idx.par_sort_unstable_by_key(|&i| store.qty[i as usize]),
        SortKey::Active => idx.par_sort_unstable_by_key(|&i| store.active[i as usize]),
        // No `Ord` for f64; total_cmp gives a total order without NaN surprises.
        SortKey::Price => idx.par_sort_unstable_by(|&a, &b| {
            store.price[a as usize].total_cmp(&store.price[b as usize])
        }),
    }
    if desc {
        idx.reverse();
    }
}

#[derive(Serialize)]
pub struct Stats {
    pub matched: usize,
    pub total: usize,
    pub price_sum: f64,
    pub price_avg: f64,
    pub price_min: f64,
    pub price_max: f64,
    pub qty_sum: i64,
    pub active_count: usize,
    /// Parallel to `store::STATUS`.
    pub by_status: Vec<StatusCount>,
}

#[derive(Serialize)]
pub struct StatusCount {
    pub status: &'static str,
    pub count: usize,
}

/// Aggregate over the selected index set. Runs server-side precisely so the
/// browser never has to hold 3M rows to show a footer total.
pub fn stats(store: &ColumnStore, idx: &[u32]) -> Stats {
    #[derive(Clone)]
    struct Acc {
        sum: f64,
        min: f64,
        max: f64,
        qty: i64,
        active: usize,
        by_status: [usize; STATUS.len()],
    }

    let identity = Acc {
        sum: 0.0,
        min: f64::INFINITY,
        max: f64::NEG_INFINITY,
        qty: 0,
        active: 0,
        by_status: [0; STATUS.len()],
    };

    let acc = idx
        .par_iter()
        .fold(
            || identity.clone(),
            |mut a, &i| {
                let i = i as usize;
                let p = store.price[i];
                a.sum += p;
                if p < a.min {
                    a.min = p;
                }
                if p > a.max {
                    a.max = p;
                }
                a.qty += store.qty[i] as i64;
                a.active += store.active[i] as usize;
                a.by_status[store.status[i] as usize] += 1;
                a
            },
        )
        .reduce(
            || identity.clone(),
            |mut a, b| {
                a.sum += b.sum;
                a.min = a.min.min(b.min);
                a.max = a.max.max(b.max);
                a.qty += b.qty;
                a.active += b.active;
                for (slot, v) in a.by_status.iter_mut().zip(b.by_status) {
                    *slot += v;
                }
                a
            },
        );

    let matched = idx.len();
    Stats {
        matched,
        total: store.len,
        price_sum: acc.sum,
        price_avg: if matched == 0 {
            0.0
        } else {
            acc.sum / matched as f64
        },
        price_min: if matched == 0 { 0.0 } else { acc.min },
        price_max: if matched == 0 { 0.0 } else { acc.max },
        qty_sum: acc.qty,
        active_count: acc.active,
        by_status: STATUS
            .iter()
            .enumerate()
            .map(|(i, &status)| StatusCount {
                status,
                count: acc.by_status[i],
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::generate;

    fn store() -> ColumnStore {
        generate(50_000, 9)
    }

    #[test]
    fn unfiltered_selects_everything() {
        let s = store();
        assert_eq!(select(&s, &Query::default()).len(), s.len);
    }

    #[test]
    fn status_filter_matches_stats() {
        let s = store();
        let q = Query {
            status: Some(2),
            ..Default::default()
        };
        let idx = select(&s, &q);
        assert!(idx.iter().all(|&i| s.status[i as usize] == 2));
        assert_eq!(stats(&s, &idx).matched, idx.len());
    }

    #[test]
    fn sort_by_price_is_ordered() {
        let s = store();
        let q = Query {
            sort: Some(SortKey::Price),
            ..Default::default()
        };
        let idx = select(&s, &q);
        assert!(
            idx.windows(2)
                .all(|w| s.price[w[0] as usize] <= s.price[w[1] as usize])
        );
    }

    #[test]
    fn desc_reverses() {
        let s = store();
        let asc = select(
            &s,
            &Query {
                sort: Some(SortKey::Qty),
                ..Default::default()
            },
        );
        let desc = select(
            &s,
            &Query {
                sort: Some(SortKey::Qty),
                desc: true,
                ..Default::default()
            },
        );
        assert_eq!(
            s.qty[*asc.last().unwrap() as usize],
            s.qty[desc[0] as usize]
        );
    }

    #[test]
    fn title_sort_is_lexicographic() {
        let s = store();
        let idx = select(
            &s,
            &Query {
                sort: Some(SortKey::Title),
                ..Default::default()
            },
        );
        let first = &s.title_dict[s.title_idx[idx[0] as usize] as usize];
        let last = &s.title_dict[s.title_idx[*idx.last().unwrap() as usize] as usize];
        assert!(first <= last);
    }

    #[test]
    fn text_filter_narrows() {
        let s = store();
        let idx = select(
            &s,
            &Query {
                q: Some("arctic".into()),
                ..Default::default()
            },
        );
        assert!(!idx.is_empty() && idx.len() < s.len);
        assert!(idx.iter().all(|&i| {
            s.title_dict[s.title_idx[i as usize] as usize]
                .to_lowercase()
                .contains("arctic")
        }));
    }

    #[test]
    fn stats_on_empty_selection() {
        let s = store();
        let out = stats(&s, &[]);
        assert_eq!(out.matched, 0);
        assert_eq!(out.price_min, 0.0);
    }
}
