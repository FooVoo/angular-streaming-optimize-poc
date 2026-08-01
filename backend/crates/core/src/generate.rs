//! Deterministic dataset generator.
//!
//! Each column is filled independently in parallel chunks, and every row draws from
//! its own stream seeded by `(base_seed, column_tag, row_index)`. Output is
//! byte-identical for a given seed regardless of chunk size, thread count or rayon
//! scheduling, and filling columns in place avoids the peak-memory doubling of
//! building per-row chunks and concatenating them afterwards.

use rayon::prelude::*;

use crate::rng::Rng;
use crate::store::{ColumnStore, IMAGE_POOL, STATUS};

const CHUNK: usize = 1 << 16;

/// 50 x 50 x 20 = 50,000 distinct titles. Dictionary-encoded, so a row costs
/// 4 bytes for the title and the strings ship once.
const ADJECTIVES: [&str; 50] = [
    "Amber", "Arctic", "Atomic", "Azure", "Blazing", "Bold", "Bronze", "Calm", "Cedar", "Cobalt",
    "Copper", "Coral", "Crimson", "Crystal", "Dusty", "Eager", "Ember", "Fading", "Feral",
    "Frozen", "Gilded", "Golden", "Granite", "Hidden", "Hollow", "Ivory", "Jade", "Lunar",
    "Marble", "Misty", "Neon", "Nimble", "Obsidian", "Onyx", "Pale", "Polar", "Quiet", "Rapid",
    "Rustic", "Sable", "Scarlet", "Silent", "Silver", "Solar", "Stark", "Steel", "Stone", "Swift",
    "Velvet", "Vivid",
];

const NOUNS: [&str; 50] = [
    "Anchor", "Anvil", "Arrow", "Badge", "Beacon", "Bridge", "Buffer", "Cable", "Canvas", "Cipher",
    "Compass", "Console", "Crate", "Cursor", "Dynamo", "Engine", "Falcon", "Filter", "Forge",
    "Gadget", "Gauge", "Girder", "Harbor", "Hinge", "Kernel", "Lantern", "Ledger", "Lever",
    "Marker", "Module", "Monitor", "Nozzle", "Panel", "Piston", "Pivot", "Prism", "Rivet",
    "Router", "Sensor", "Shuttle", "Signal", "Socket", "Spindle", "Stack", "Tablet", "Terminal",
    "Toggle", "Turbine", "Valve", "Widget",
];

const SUFFIXES: [&str; 20] = [
    "Mk I", "Mk II", "Mk III", "Mk IV", "Mk V", "Pro", "Lite", "Plus", "Max", "Mini", "Core",
    "Edge", "Prime", "Duo", "Nova", "X", "XL", "SE", "HD", "Air",
];

const CATEGORIES: [&str; 24] = [
    "Hardware",
    "Software",
    "Networking",
    "Storage",
    "Peripherals",
    "Cables",
    "Power",
    "Cooling",
    "Displays",
    "Audio",
    "Sensors",
    "Robotics",
    "Tooling",
    "Packaging",
    "Logistics",
    "Safety",
    "Optics",
    "Fasteners",
    "Adhesives",
    "Textiles",
    "Chemicals",
    "Lighting",
    "Batteries",
    "Spares",
];

/// 2020-01-01T00:00:00Z in epoch milliseconds.
const EPOCH_BASE_MS: i64 = 1_577_836_800_000;
/// Six years of spread.
const EPOCH_SPAN_MS: i64 = 6 * 365 * 24 * 60 * 60 * 1000;

fn build_title_dict() -> Vec<String> {
    let mut out = Vec::with_capacity(ADJECTIVES.len() * NOUNS.len() * SUFFIXES.len());
    for a in ADJECTIVES {
        for n in NOUNS {
            for s in SUFFIXES {
                out.push(format!("{a} {n} {s}"));
            }
        }
    }
    out
}

/// `rank[i]` = position of `dict[i]` in lexicographic order.
pub fn lexicographic_rank(dict: &[String]) -> Vec<u32> {
    let mut order: Vec<u32> = (0..dict.len() as u32).collect();
    order.sort_unstable_by(|&a, &b| dict[a as usize].cmp(&dict[b as usize]));
    let mut rank = vec![0u32; dict.len()];
    for (position, &idx) in order.iter().enumerate() {
        rank[idx as usize] = position as u32;
    }
    rank
}

/// Fill one column in parallel. Each row gets its own counter-seeded stream, so
/// output depends only on `(seed, column, row)` — not on chunk size, thread count
/// or scheduling order.
fn fill<T, F>(rows: usize, col_seed: u64, f: F) -> Vec<T>
where
    T: Default + Clone + Send,
    F: Fn(&mut Rng, usize) -> T + Sync + Send,
{
    let mut v = vec![T::default(); rows];
    v.par_chunks_mut(CHUNK)
        .enumerate()
        .for_each(|(chunk, slice)| {
            let base = chunk * CHUNK;
            for (i, slot) in slice.iter_mut().enumerate() {
                let row = base + i;
                let mut rng = Rng::counter(col_seed, row as u64);
                *slot = f(&mut rng, row);
            }
        });
    v
}

pub fn generate(rows: usize, seed: u64) -> ColumnStore {
    let title_dict = build_title_dict();
    let title_rank = lexicographic_rank(&title_dict);
    let title_dict_len = title_dict.len() as u32;
    let category_dict: Vec<String> = CATEGORIES.iter().map(|s| s.to_string()).collect();

    // Column tags keep the per-column streams independent.
    let (id, created_at, title_idx, category_idx) = {
        let id = fill(rows, seed ^ 0x01, |_, i| i as u32 + 1);
        let created_at = fill(rows, seed ^ 0x02, |r, _| {
            EPOCH_BASE_MS + (r.f64_01() * EPOCH_SPAN_MS as f64) as i64
        });
        let title_idx = fill(rows, seed ^ 0x03, |r, _| r.below(title_dict_len));
        // Skewed: a handful of categories dominate, so filtered result sets vary
        // by orders of magnitude instead of all landing near rows/24.
        let category_idx = fill(rows, seed ^ 0x04, |r, _| {
            r.skewed_below(CATEGORIES.len() as u32, 1.8) as u16
        });
        (id, created_at, title_idx, category_idx)
    };

    let status = fill(rows, seed ^ 0x05, |r, _| {
        r.skewed_below(STATUS.len() as u32, 1.4) as u8
    });
    let price = fill(rows, seed ^ 0x06, |r, _| {
        // 1.00 .. 9999.99, log-ish spread so most rows are cheap.
        let x = r.f64_01().powf(2.2);
        ((1.0 + x * 9_998.99) * 100.0).round() / 100.0
    });
    let qty = fill(rows, seed ^ 0x07, |r, _| r.skewed_below(5_000, 2.0) as i32);
    let active = fill(rows, seed ^ 0x08, |r, _| r.below(100) < 85);
    let image_id = fill(rows, seed ^ 0x09, |r, _| r.below(IMAGE_POOL as u32) as u16);

    ColumnStore {
        len: rows,
        id,
        created_at,
        title_idx,
        category_idx,
        status,
        price,
        qty,
        active,
        image_id,
        title_dict,
        category_dict,
        title_rank,
    }
}

#[cfg(test)]
mod tests {
    use super::generate;

    #[test]
    fn same_seed_same_bytes() {
        let a = generate(200_000, 42);
        let b = generate(200_000, 42);
        assert_eq!(a.price, b.price);
        assert_eq!(a.title_idx, b.title_idx);
        assert_eq!(a.image_id, b.image_id);
    }

    #[test]
    fn different_seed_differs() {
        let a = generate(10_000, 1);
        let b = generate(10_000, 2);
        assert_ne!(a.price, b.price);
    }

    #[test]
    fn ids_are_dense_and_one_based() {
        let s = generate(100_000, 3);
        assert_eq!(s.id[0], 1);
        assert_eq!(s.id[99_999], 100_000);
    }

    /// Regression for the chunk-seed overlap bug: whole rows were duplicated
    /// across chunks because two RNG streams were shifted copies of each other.
    #[test]
    fn rows_are_not_wholesale_duplicates() {
        let s = generate(400_000, 42);
        let mut seen = std::collections::HashSet::with_capacity(s.len);
        for i in 0..s.len {
            let key = (
                s.created_at[i],
                s.title_idx[i],
                s.price[i].to_bits(),
                s.qty[i],
                s.image_id[i],
                s.category_idx[i],
            );
            assert!(seen.insert(key), "duplicate row payload at index {i}");
        }
    }

    #[test]
    fn dictionary_indices_in_range() {
        let s = generate(50_000, 4);
        let t = s.title_dict.len() as u32;
        assert!(s.title_idx.iter().all(|&i| i < t));
        let c = s.category_dict.len() as u16;
        assert!(s.category_idx.iter().all(|&i| i < c));
    }
}
