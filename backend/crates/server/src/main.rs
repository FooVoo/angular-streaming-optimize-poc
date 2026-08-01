//! POC server: one binary holding a 20M-row columnar dataset in memory and serving
//! it four different ways so the frontend can measure which shape actually wins.

mod api;
mod assets;
mod state;
mod stream;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use axum::Router;
use axum::routing::{get, patch};
use clap::Parser;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, Predicate};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use poc_core::store::IMAGE_POOL;

use crate::state::{AppState, Shared};

#[derive(Parser, Debug)]
#[command(name = "poc-server", about = "Streaming/optimisation POC backend")]
struct Args {
    /// Rows to generate at startup. At 34 bytes per row, 20M costs ~680 MB of
    /// columns plus ~80 MB per cached index permutation.
    #[arg(long, default_value_t = 20_000_000)]
    rows: usize,

    /// Generator seed. Same seed produces byte-identical data.
    #[arg(long, default_value_t = 42)]
    seed: u64,

    #[arg(long, default_value_t = 8080)]
    port: u16,

    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    /// Size of the procedural thumbnail pool.
    #[arg(long, default_value_t = IMAGE_POOL)]
    images: u16,

    /// Serve a distinct generated image per row instead of pooling. Defeats HTTP
    /// caching on purpose so the miss path can be measured.
    #[arg(long)]
    unique_images: bool,

    /// Default row ceiling for the streaming endpoints. The frontend can override
    /// per request; this is what "load everything" means by default.
    #[arg(long, default_value_t = 250_000)]
    stream_cap: usize,

    /// Optional built frontend to serve from the same origin.
    #[arg(long)]
    static_dir: Option<PathBuf>,
}

/// Skip compression when a handler asked for it — PNGs, and the `?nobr=1` runs
/// that measure what brotli is actually worth on each wire format.
#[derive(Clone)]
struct RespectNoCompress(DefaultPredicate);

impl Predicate for RespectNoCompress {
    fn should_compress<B>(&self, response: &http::Response<B>) -> bool
    where
        B: http_body::Body,
    {
        if response.headers().contains_key("x-no-compress") {
            return false;
        }
        self.0.should_compress(response)
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let t0 = Instant::now();
    let store = poc_core::generate(args.rows, args.seed);
    let gen_ms = t0.elapsed().as_millis();
    let heap_mb = store.heap_bytes() as f64 / 1_048_576.0;
    println!(
        "generated {} rows in {} ms ({:.1} MB resident)",
        args.rows, gen_ms, heap_mb
    );

    let t1 = Instant::now();
    let pool = poc_core::build_pool(args.images);
    let images_ms = t1.elapsed().as_millis();
    println!(
        "built {} thumbnails + {}x{} atlas ({:.0} KB) in {} ms",
        args.images,
        pool.meta.width,
        pool.meta.height,
        pool.atlas_png.len() as f64 / 1024.0,
        images_ms
    );

    let shared: Shared = Arc::new(AppState {
        store: RwLock::new(store),
        pool,
        cache: Mutex::new(Vec::new()),
        version: AtomicU64::new(0),
        unique_images: args.unique_images,
        seed: args.seed,
        rows: args.rows,
        stream_cap: args.stream_cap,
        gen_ms,
        images_ms,
    });

    let mut app = Router::new()
        .route("/api/health", get(api::health))
        .route("/api/meta", get(api::meta))
        .route("/api/dict/title", get(api::title_dict))
        .route("/api/stats", get(api::stats))
        .route("/api/rows", get(api::rows))
        .route("/api/rows/{id}", patch(api::patch_row))
        .route("/api/rows/ndjson", get(stream::ndjson))
        .route("/api/rows/arrow", get(stream::arrow_stream))
        .route("/api/rows/datauri", get(stream::datauri))
        .route("/api/thumb/{image_id}", get(assets::thumb))
        .route("/api/thumb/row/{row_id}", get(assets::thumb_row))
        .route("/api/atlas.png", get(assets::atlas_png))
        .route("/api/atlas.json", get(assets::atlas_json))
        .with_state(shared);

    if let Some(dir) = args.static_dir.as_ref() {
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
        println!("serving frontend from {}", dir.display());
    }

    let app = app
        .layer(CompressionLayer::new().compress_when(RespectNoCompress(DefaultPredicate::new())))
        // No auth anywhere in this POC; it binds to loopback by default and the
        // dataset is synthetic.
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::new(args.host, args.port);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("listening on http://{addr}");
    println!(
        "note: plain HTTP means HTTP/1.1 and a 6-connection-per-origin cap in browsers — \
         relevant to per-row thumbnail mode, see README"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}
