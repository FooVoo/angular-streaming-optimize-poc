use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use poc_core::query::{Query, SortKey};
use poc_core::{ColumnStore, ImagePool};

/// Small move-to-front cache of index permutations, keyed by query + store
/// version. Paging through a sorted result must not re-sort per page — this is
/// the server-side twin of "cache decoded typed arrays by query hash".
///
/// Kept at three because each entry is 4 bytes per matched row: at 20M rows an
/// unfiltered permutation is 80 MB, so a generous cache silently costs more than
/// the dataset it accelerates.
const CACHE_SLOTS: usize = 3;

pub struct AppState {
    pub store: RwLock<ColumnStore>,
    pub pool: ImagePool,
    pub cache: Mutex<Vec<(u64, Arc<Vec<u32>>)>>,
    /// Bumped on every mutation so cached permutations are invalidated.
    pub version: AtomicU64,
    pub unique_images: bool,
    pub seed: u64,
    pub rows: usize,
    pub stream_cap: usize,
    pub gen_ms: u128,
    pub images_ms: u128,
}

impl AppState {
    /// Selected indices for a query, from cache when possible.
    pub fn select(&self, query: &Query) -> Arc<Vec<u32>> {
        let key = query.cache_key() ^ self.version.load(Ordering::Acquire).wrapping_mul(0x9E37);
        if let Ok(mut cache) = self.cache.lock()
            && let Some(pos) = cache.iter().position(|(k, _)| *k == key)
        {
            let hit = cache.remove(pos);
            let idx = hit.1.clone();
            cache.insert(0, (key, idx.clone()));
            return idx;
        }
        let store = self.store.read().expect("store poisoned");
        let idx = Arc::new(poc_core::select(&store, query));
        drop(store);
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(0, (key, idx.clone()));
            cache.truncate(CACHE_SLOTS);
        }
        idx
    }

    pub fn invalidate(&self) {
        self.version.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut cache) = self.cache.lock() {
            cache.clear();
        }
    }
}

pub type Shared = Arc<AppState>;

/// Hand-rolled query-string mapping. Unknown keys are ignored and bad values fall
/// back to the default rather than 400-ing — this is a demo surface, and a typo in
/// a benchmark URL should not look like a server failure.
pub fn parse_query(params: &HashMap<String, String>) -> Query {
    let get = |k: &str| params.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    Query {
        q: get("q").map(str::to_string),
        status: get("status").and_then(|s| {
            poc_core::STATUS
                .iter()
                .position(|x| *x == s)
                .map(|i| i as u8)
                .or_else(|| s.parse().ok())
        }),
        category: get("category").and_then(|s| s.parse().ok()),
        active: get("active").and_then(|s| match s {
            "1" | "true" => Some(true),
            "0" | "false" => Some(false),
            _ => None,
        }),
        min_price: get("min_price").and_then(|s| s.parse().ok()),
        max_price: get("max_price").and_then(|s| s.parse().ok()),
        sort: get("sort").and_then(SortKey::parse),
        desc: get("dir").is_some_and(|d| d.eq_ignore_ascii_case("desc")),
    }
}

pub fn parse_usize(params: &HashMap<String, String>, key: &str, default: usize) -> usize {
    params
        .get(key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

pub fn flag(params: &HashMap<String, String>, key: &str) -> bool {
    params
        .get(key)
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}
