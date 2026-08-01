//! Thumbnail delivery: pooled PNGs, the sprite atlas, and the deliberately
//! cache-hostile per-row variant.

use std::collections::HashMap;

use axum::extract::{Path, Query as AxumQuery, State};
use axum::http::{StatusCode, header};
use axum::response::Response;

use poc_core::images::{THUMB, THUMB_2X, render_png_for};

use crate::state::Shared;

/// Pool images never change for a given seed, so they get the strongest cache
/// headers available. After the first screens the network is out of the picture
/// entirely — which is the whole reason a 512-image pool beats 3M unique files.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

fn png_response(bytes: Vec<u8>, cache: &str, etag: Option<String>) -> Response {
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, cache)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        // PNG is already deflated; compressing again costs CPU for nothing.
        .header("x-no-compress", "1");
    if let Some(tag) = etag {
        res = res.header(header::ETAG, tag);
    }
    res.body(bytes.into()).expect("response")
}

pub async fn thumb(
    State(state): State<Shared>,
    Path(image_id): Path<u16>,
    AxumQuery(params): AxumQuery<HashMap<String, String>>,
) -> Result<Response, StatusCode> {
    let retina = params.get("dpr").is_some_and(|d| d == "2");
    let set = if retina {
        &state.pool.png_2x
    } else {
        &state.pool.png_1x
    };
    let bytes = set.get(image_id as usize).ok_or(StatusCode::NOT_FOUND)?;
    let tag = format!(
        "\"{}-{}-{}\"",
        state.seed,
        image_id,
        if retina { 2 } else { 1 }
    );
    Ok(png_response(bytes.clone(), IMMUTABLE, Some(tag)))
}

/// `--unique-images` mode: a distinct PNG per row id, generated on demand. Every
/// scroll is a cache miss and a fresh render, which is exactly the point — it is
/// the control case the pooled path is measured against.
pub async fn thumb_row(
    State(state): State<Shared>,
    Path(row_id): Path<u32>,
    AxumQuery(params): AxumQuery<HashMap<String, String>>,
) -> Result<Response, StatusCode> {
    if row_id == 0 || row_id as usize > state.rows {
        return Err(StatusCode::NOT_FOUND);
    }
    let size = if params.get("dpr").is_some_and(|d| d == "2") {
        THUMB_2X
    } else {
        THUMB
    };
    let bytes = render_png_for(row_id, size);
    // Short cache, not immutable: the browser must come back often enough for the
    // miss cost to show up in the HUD.
    Ok(png_response(bytes, "public, max-age=30", None))
}

pub async fn atlas_png(State(state): State<Shared>) -> Response {
    png_response(
        state.pool.atlas_png.clone(),
        IMMUTABLE,
        Some(format!("\"atlas-{}\"", state.seed)),
    )
}

pub async fn atlas_json(State(state): State<Shared>) -> Response {
    let body = serde_json::to_string(&state.pool.meta).expect("atlas json");
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, IMMUTABLE)
        .body(body.into())
        .expect("response")
}
