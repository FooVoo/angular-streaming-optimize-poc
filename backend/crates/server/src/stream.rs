//! Bulk transfer modes: NDJSON (B), Arrow IPC (C), and the data-URI anti-pattern.
//!
//! All three walk the same index permutation in chunks and yield each chunk as it
//! is produced, so the browser can render its first rows while the rest is still
//! being serialised. Time-to-first-row is the metric these endpoints exist to move.

use std::collections::HashMap;
use std::convert::Infallible;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use arrow::array::{
    ArrayRef, BooleanArray, Float64Array, Int32Array, Int64Array, UInt8Array, UInt16Array,
    UInt32Array,
};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use axum::body::Body;
use axum::extract::{Query as AxumQuery, State};
use axum::http::header;
use axum::response::Response;
use bytes::Bytes;
use futures::{StreamExt, stream};

use poc_core::images::base64;

use crate::state::{Shared, flag, parse_query, parse_usize};

/// NDJSON flush granularity. Small enough that the first rows paint immediately,
/// large enough that per-chunk overhead stays invisible.
const NDJSON_CHUNK: usize = 5_000;
/// Arrow record batch size. Bigger batches amortise framing; 64k keeps each
/// postMessage transfer under a few MB.
const ARROW_BATCH: usize = 65_536;
/// Hard cap on the deliberately-bad endpoint. Past this it is not a demo, it is
/// an out-of-memory error.
const DATAURI_CAP: usize = 10_000;

fn streaming_response(
    content_type: &str,
    matched: usize,
    sent: usize,
    no_compress: bool,
    body: Body,
) -> Response {
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header("x-matched-rows", matched.to_string())
        .header("x-sent-rows", sent.to_string())
        // Exposed so the frontend HUD can read them cross-origin in dev.
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "x-matched-rows,x-sent-rows,x-uncompressed-bytes",
        );
    if no_compress {
        res = res.header("x-no-compress", "1");
    }
    res.body(body).expect("response")
}

/// Mode B — newline-delimited JSON.
///
/// `shape=array` (default) emits dictionary-indexed tuples: the fastest JSON can
/// realistically be, and therefore the fair opponent for Arrow. `shape=object`
/// emits denormalised objects — the naive shape, kept so the gap is measurable
/// rather than asserted.
pub async fn ndjson(
    State(state): State<Shared>,
    AxumQuery(params): AxumQuery<HashMap<String, String>>,
) -> Response {
    let query = parse_query(&params);
    let idx = state.select(&query);
    let limit = parse_usize(&params, "limit", state.stream_cap).min(idx.len());
    let objects = params.get("shape").is_some_and(|s| s == "object");
    let chunk = parse_usize(&params, "chunk", NDJSON_CHUNK).clamp(100, 100_000);
    let no_compress = flag(&params, "nobr");

    let header_line = format!(
        "{{\"kind\":\"header\",\"matched\":{},\"sent\":{},\"shape\":\"{}\",\"columns\":[\"id\",\"created_at\",\"title_idx\",\"category_idx\",\"status\",\"price\",\"qty\",\"active\",\"image_id\"]}}\n",
        idx.len(),
        limit,
        if objects { "object" } else { "array" }
    );

    let body = stream::unfold(
        (state.clone(), idx.clone(), 0usize, Some(header_line)),
        move |(state, idx, cursor, header)| async move {
            if let Some(h) = header {
                return Some((
                    Ok::<Bytes, Infallible>(Bytes::from(h)),
                    (state, idx, cursor, None),
                ));
            }
            if cursor >= limit {
                return None;
            }
            let end = (cursor + chunk).min(limit);
            let mut buf = String::with_capacity((end - cursor) * 64);
            {
                let store = state.store.read().expect("store poisoned");
                for &i in &idx[cursor..end] {
                    let i = i as usize;
                    if objects {
                        buf.push_str(&serde_json::to_string(&store.row(i)).expect("row json"));
                        buf.push('\n');
                    } else {
                        let _ = writeln!(
                            buf,
                            "[{},{},{},{},{},{},{},{},{}]",
                            store.id[i],
                            store.created_at[i],
                            store.title_idx[i],
                            store.category_idx[i],
                            store.status[i],
                            store.price[i],
                            store.qty[i],
                            store.active[i] as u8,
                            store.image_id[i]
                        );
                    }
                }
            }
            Some((Ok(Bytes::from(buf)), (state, idx, end, None)))
        },
    );

    streaming_response(
        "application/x-ndjson",
        idx.len(),
        limit,
        no_compress,
        // `unfold` panics if polled after it yields `None`, and the compression
        // layer does exactly that. Fusing is required, not defensive.
        Body::from_stream(body.fuse()),
    )
}

fn arrow_schema() -> Schema {
    Schema::new(vec![
        Field::new("id", DataType::UInt32, false),
        Field::new("created_at", DataType::Int64, false),
        Field::new("title_idx", DataType::UInt32, false),
        Field::new("category_idx", DataType::UInt16, false),
        Field::new("status", DataType::UInt8, false),
        Field::new("price", DataType::Float64, false),
        Field::new("qty", DataType::Int32, false),
        Field::new("active", DataType::Boolean, false),
        Field::new("image_id", DataType::UInt16, false),
    ])
}

/// A `Write` sink we can drain between batches. `StreamWriter` owns its writer, so
/// sharing the buffer is how each record batch gets handed to the response stream
/// the moment it is encoded instead of at the end.
#[derive(Clone, Default)]
struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl SharedBuf {
    fn take(&self) -> Vec<u8> {
        std::mem::take(&mut *self.0.lock().expect("buffer poisoned"))
    }
}

impl std::io::Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("buffer poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Mode C — Arrow IPC stream.
///
/// Columns go out as contiguous native-endian buffers, so the browser constructs
/// typed-array views over the received bytes and allocates no per-row objects at
/// all. Strings stay dictionary-indexed and ship once via `/api/dict/title`.
pub async fn arrow_stream(
    State(state): State<Shared>,
    AxumQuery(params): AxumQuery<HashMap<String, String>>,
) -> Response {
    let query = parse_query(&params);
    let idx = state.select(&query);
    let limit = parse_usize(&params, "limit", state.stream_cap).min(idx.len());
    let batch_size = parse_usize(&params, "batch", ARROW_BATCH).clamp(1_024, 262_144);
    let no_compress = flag(&params, "nobr");

    let schema = Arc::new(arrow_schema());
    let sink = SharedBuf::default();
    let writer = StreamWriter::try_new(sink.clone(), &schema).expect("arrow writer");

    let body = stream::unfold(
        (state.clone(), idx.clone(), 0usize, writer, sink, false),
        move |(state, idx, cursor, mut writer, sink, finished)| {
            // Cloned per call: an `async move` block would otherwise move the
            // captured schema out of the closure on the first batch.
            let schema = schema.clone();
            async move {
                if finished {
                    return None;
                }
                if cursor >= limit {
                    writer.finish().expect("arrow finish");
                    let tail = sink.take();
                    return Some((
                        Ok::<Bytes, Infallible>(Bytes::from(tail)),
                        (state, idx, cursor, writer, sink, true),
                    ));
                }
                let end = (cursor + batch_size).min(limit);
                let batch = {
                    let store = state.store.read().expect("store poisoned");
                    let window = &idx[cursor..end];
                    let gather_u32 = |src: &Vec<u32>| -> Vec<u32> {
                        window.iter().map(|&i| src[i as usize]).collect()
                    };
                    let columns: Vec<ArrayRef> = vec![
                        Arc::new(UInt32Array::from(gather_u32(&store.id))),
                        Arc::new(Int64Array::from(
                            window
                                .iter()
                                .map(|&i| store.created_at[i as usize])
                                .collect::<Vec<_>>(),
                        )),
                        Arc::new(UInt32Array::from(gather_u32(&store.title_idx))),
                        Arc::new(UInt16Array::from(
                            window
                                .iter()
                                .map(|&i| store.category_idx[i as usize])
                                .collect::<Vec<_>>(),
                        )),
                        Arc::new(UInt8Array::from(
                            window
                                .iter()
                                .map(|&i| store.status[i as usize])
                                .collect::<Vec<_>>(),
                        )),
                        Arc::new(Float64Array::from(
                            window
                                .iter()
                                .map(|&i| store.price[i as usize])
                                .collect::<Vec<_>>(),
                        )),
                        Arc::new(Int32Array::from(
                            window
                                .iter()
                                .map(|&i| store.qty[i as usize])
                                .collect::<Vec<_>>(),
                        )),
                        Arc::new(BooleanArray::from(
                            window
                                .iter()
                                .map(|&i| store.active[i as usize])
                                .collect::<Vec<_>>(),
                        )),
                        Arc::new(UInt16Array::from(
                            window
                                .iter()
                                .map(|&i| store.image_id[i as usize])
                                .collect::<Vec<_>>(),
                        )),
                    ];
                    RecordBatch::try_new(schema.clone(), columns).expect("record batch")
                };
                writer.write(&batch).expect("arrow write");
                writer.flush().expect("arrow flush");
                let bytes = sink.take();
                Some((
                    Ok(Bytes::from(bytes)),
                    (state, idx, end, writer, sink, false),
                ))
            }
        },
    );

    streaming_response(
        "application/vnd.apache.arrow.stream",
        idx.len(),
        limit,
        no_compress,
        Body::from_stream(body.fuse()),
    )
}

/// The anti-pattern, capped at 10k rows: every thumbnail inlined as a base64 data
/// URI. Included to make the cost curve visible rather than theoretical — at 3M
/// rows this shape is roughly six gigabytes.
pub async fn datauri(
    State(state): State<Shared>,
    AxumQuery(params): AxumQuery<HashMap<String, String>>,
) -> Response {
    let query = parse_query(&params);
    let idx = state.select(&query);
    let limit = parse_usize(&params, "limit", 2_000)
        .min(DATAURI_CAP)
        .min(idx.len());

    let mut buf = String::with_capacity(limit * 3_000);
    buf.push_str(&format!(
        "{{\"kind\":\"header\",\"matched\":{},\"sent\":{limit}}}\n",
        idx.len()
    ));
    {
        let store = state.store.read().expect("store poisoned");
        for &i in &idx[..limit] {
            let i = i as usize;
            let row = store.row(i);
            let png = &state.pool.png_1x[store.image_id[i] as usize % state.pool.png_1x.len()];
            let mut value = serde_json::to_value(&row).expect("row value");
            value["thumb"] =
                serde_json::Value::String(format!("data:image/png;base64,{}", base64(png)));
            let _ = writeln!(buf, "{value}");
        }
    }
    let sent = limit;
    let len = buf.len();
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header("x-matched-rows", idx.len().to_string())
        .header("x-sent-rows", sent.to_string())
        .header("x-uncompressed-bytes", len.to_string())
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "x-matched-rows,x-sent-rows,x-uncompressed-bytes",
        );
    if flag(&params, "nobr") {
        res = res.header("x-no-compress", "1");
    }
    res.body(Body::from(buf)).expect("response")
}
