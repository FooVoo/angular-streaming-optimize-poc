//! Columnar row store (struct-of-arrays).
//!
//! Deliberately NOT `Vec<Row>`: at 3M rows a row-of-structs layout with owned
//! `String` titles costs ~600 MB and destroys cache locality on every scan.
//! Struct-of-arrays with dictionary-encoded strings is ~102 MB and is what makes
//! the Arrow / typed-array wire formats a zero-transform dump of memory.

use serde::Serialize;

pub const STATUS: [&str; 5] = ["draft", "review", "published", "archived", "flagged"];

/// Number of distinct procedural thumbnails. Rows reference the pool by index,
/// so the image costs 2 bytes per row on the wire instead of ~2 KB.
pub const IMAGE_POOL: u16 = 512;

#[derive(Default)]
pub struct ColumnStore {
    pub len: usize,
    pub id: Vec<u32>,
    /// Epoch milliseconds.
    pub created_at: Vec<i64>,
    pub title_idx: Vec<u32>,
    pub category_idx: Vec<u16>,
    pub status: Vec<u8>,
    pub price: Vec<f64>,
    pub qty: Vec<i32>,
    pub active: Vec<bool>,
    pub image_id: Vec<u16>,
    pub title_dict: Vec<String>,
    pub category_dict: Vec<String>,
    /// Lexicographic rank of each `title_dict` entry. Sorting 3M rows by title
    /// compares two `u32` ranks instead of two strings — the dictionary is sorted
    /// once at startup (50k entries) and every later sort is integer-cheap.
    pub title_rank: Vec<u32>,
}

/// Denormalised single row — used by the paged-JSON baseline and by PATCH
/// responses only. Never used for bulk transfer; that is the entire point.
#[derive(Serialize)]
pub struct RowView<'a> {
    pub id: u32,
    pub created_at: i64,
    pub title: &'a str,
    pub category: &'a str,
    pub status: &'a str,
    pub price: f64,
    pub qty: i32,
    pub active: bool,
    pub image_id: u16,
}

impl ColumnStore {
    pub fn row(&self, i: usize) -> RowView<'_> {
        RowView {
            id: self.id[i],
            created_at: self.created_at[i],
            title: &self.title_dict[self.title_idx[i] as usize],
            category: &self.category_dict[self.category_idx[i] as usize],
            status: STATUS[self.status[i] as usize],
            price: self.price[i],
            qty: self.qty[i],
            active: self.active[i],
            image_id: self.image_id[i],
        }
    }

    /// Resident bytes of the column data. Reported by `/api/meta` so the frontend
    /// HUD can show server-side footprint next to the browser heap.
    pub fn heap_bytes(&self) -> usize {
        let n = self.len;
        let columns = n * (4 + 8 + 4 + 2 + 1 + 8 + 4 + 1 + 2);
        let dicts: usize = self
            .title_dict
            .iter()
            .chain(self.category_dict.iter())
            .map(|s| s.len() + std::mem::size_of::<String>())
            .sum();
        columns + dicts
    }
}
