//! Runtime-agnostic core: dataset generation, columnar storage, index-permutation
//! query, procedural images. No axum, no tokio — so `cargo test -p poc-core` runs
//! the whole data layer without a server or a browser.

pub mod generate;
pub mod images;
pub mod query;
pub mod rng;
pub mod store;

pub use generate::generate;
pub use images::{ImagePool, build_pool};
pub use query::{Query, SortKey, select, stats};
pub use store::{ColumnStore, IMAGE_POOL, RowView, STATUS};
