//! Non-streaming JSON surface: metadata, the paged baseline, aggregates, edits.

use std::collections::HashMap;

use axum::extract::{Path, Query as AxumQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, response::Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use poc_core::generate::lexicographic_rank;
use poc_core::store::RowView;

use crate::state::{Shared, flag, parse_query, parse_usize};

/// A single page is deliberately capped. The baseline mode's whole argument is
/// that you never ship more than a screen's worth.
const MAX_PAGE: usize = 5_000;

fn json_response(body: String, cache: Option<&str>, no_compress: bool) -> Response {
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-uncompressed-bytes", body.len().to_string());
    if let Some(c) = cache {
        res = res.header(header::CACHE_CONTROL, c);
    }
    if no_compress {
        res = res.header("x-no-compress", "1");
    }
    res.body(body.into()).expect("response")
}

pub async fn meta(State(state): State<Shared>) -> Response {
    let store = state.store.read().expect("store poisoned");
    let body = json!({
        "rows": store.len,
        "seed": state.seed,
        "server_heap_bytes": store.heap_bytes(),
        "generate_ms": state.gen_ms,
        "images_ms": state.images_ms,
        "stream_cap": state.stream_cap,
        "unique_images": state.unique_images,
        "title_dict_len": store.title_dict.len(),
        "categories": store.category_dict,
        "statuses": poc_core::STATUS,
        "atlas": state.pool.meta,
        "columns": [
            {"key": "image_id", "label": "", "type": "image", "width": 56},
            {"key": "id", "label": "ID", "type": "int", "width": 90},
            {"key": "title", "label": "Title", "type": "dict", "width": 260},
            {"key": "category", "label": "Category", "type": "dict", "width": 140},
            {"key": "status", "label": "Status", "type": "enum", "width": 120},
            {"key": "price", "label": "Price", "type": "money", "width": 110},
            {"key": "qty", "label": "Qty", "type": "int", "width": 90},
            {"key": "created_at", "label": "Created", "type": "date", "width": 160},
            {"key": "active", "label": "Active", "type": "bool", "width": 90}
        ]
    })
    .to_string();
    drop(store);
    json_response(body, None, false)
}

/// The title dictionary — 50k strings shipped once and cached forever. This is
/// what makes a 4-byte `title_idx` on the wire legitimate rather than a trick.
pub async fn title_dict(State(state): State<Shared>) -> Response {
    let store = state.store.read().expect("store poisoned");
    let body = serde_json::to_string(&store.title_dict).expect("dict json");
    drop(store);
    json_response(body, Some("public, max-age=3600"), false)
}

#[derive(Serialize)]
struct Page<'a> {
    total: usize,
    matched: usize,
    offset: usize,
    limit: usize,
    rows: Vec<RowView<'a>>,
}

/// Mode A — server-side window. Sort, filter and paginate on the server, ship a
/// screen's worth of denormalised rows.
pub async fn rows(
    State(state): State<Shared>,
    AxumQuery(params): AxumQuery<HashMap<String, String>>,
) -> Response {
    let query = parse_query(&params);
    let idx = state.select(&query);
    let offset = parse_usize(&params, "offset", 0).min(idx.len());
    let limit = parse_usize(&params, "limit", 100).min(MAX_PAGE);
    let window = &idx[offset..(offset + limit).min(idx.len())];

    let store = state.store.read().expect("store poisoned");
    let page = Page {
        total: store.len,
        matched: idx.len(),
        offset,
        limit,
        rows: window.iter().map(|&i| store.row(i as usize)).collect(),
    };
    let body = serde_json::to_string(&page).expect("page json");
    drop(store);
    json_response(body, None, flag(&params, "nobr"))
}

pub async fn stats(
    State(state): State<Shared>,
    AxumQuery(params): AxumQuery<HashMap<String, String>>,
) -> Response {
    let query = parse_query(&params);
    let idx = state.select(&query);
    let store = state.store.read().expect("store poisoned");
    let body = serde_json::to_string(&poc_core::stats(&store, &idx)).expect("stats json");
    drop(store);
    json_response(body, None, false)
}

#[derive(Deserialize)]
pub struct Patch {
    pub title: Option<String>,
    pub price: Option<f64>,
    pub qty: Option<i32>,
    pub status: Option<String>,
    pub active: Option<bool>,
}

/// Edits mutate the columns in place. Included so the table is a CMS and not a
/// read-only benchmark — and to prove the index cache invalidates correctly.
pub async fn patch_row(
    State(state): State<Shared>,
    Path(id): Path<u32>,
    Json(patch): Json<Patch>,
) -> Result<Response, (StatusCode, String)> {
    let mut store = state.store.write().expect("store poisoned");
    if id == 0 || id as usize > store.len {
        return Err((StatusCode::NOT_FOUND, format!("no row {id}")));
    }
    // Ids are dense and 1-based, so the row index is exact without a scan.
    let i = id as usize - 1;

    if let Some(price) = patch.price {
        store.price[i] = price;
    }
    if let Some(qty) = patch.qty {
        store.qty[i] = qty;
    }
    if let Some(active) = patch.active {
        store.active[i] = active;
    }
    if let Some(status) = patch.status {
        match poc_core::STATUS.iter().position(|s| *s == status) {
            Some(pos) => store.status[i] = pos as u8,
            None => return Err((StatusCode::BAD_REQUEST, format!("bad status {status}"))),
        }
    }
    if let Some(title) = patch.title {
        let existing = store.title_dict.iter().position(|t| *t == title);
        let dict_idx = match existing {
            Some(pos) => pos,
            None => {
                store.title_dict.push(title);
                // Ranks are positions in a sorted view of the whole dictionary, so
                // appending one entry shifts others. 50k entries, a few ms.
                store.title_rank = lexicographic_rank(&store.title_dict);
                store.title_dict.len() - 1
            }
        };
        store.title_idx[i] = dict_idx as u32;
    }

    let body = serde_json::to_string(&store.row(i)).expect("row json");
    drop(store);
    state.invalidate();
    Ok(json_response(body, None, false))
}

pub async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}
