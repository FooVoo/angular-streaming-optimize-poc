# angular-streaming-optimize-poc

A CMS-style table over **20 million rows**, served by Rust/axum and rendered by Angular 22,
with four interchangeable transports and a HUD that measures all of them under identical
rendering conditions.

The question it answers: when a grid feels slow, where does the cost actually sit — the
wire format, the parse, or the render? Everything here exists to make that measurable
instead of arguable.

## Run it

```bash
# backend — generates 20M rows in memory at startup (~220 ms, ~650 MB)
cd backend && cargo run --release

# frontend — proxies /api to 127.0.0.1:8080
cd frontend && npm install && npm start
```

Then open <http://localhost:4200>. No auth, no database, no persistence: the dataset is
regenerated deterministically from a seed on every boot.

With `just` installed: `just dev` runs both, `just test` runs both test suites.

Useful flags:

```bash
cargo run --release -- --rows 3000000        # smaller dataset
cargo run --release -- --seed 7              # different data, still reproducible
cargo run --release -- --unique-images       # a distinct image per row (defeats caching)
cargo run --release -- --static-dir ../frontend/dist/frontend/browser   # single binary
```

## The four transports

Pick one in the toolbar; the renderer, the columns and the measurements are identical
across all of them.

| | mode | shape |
|---|---|---|
| **A** | paged JSON | server sorts/filters/paginates, ships ~100 denormalised rows |
| **B** | NDJSON stream | dictionary-indexed tuples, parsed in a worker |
| **B2** | NDJSON objects | denormalised objects — the naive shape, kept for contrast |
| **C** | Arrow IPC | columnar batches, typed-array views, no per-row objects |
| **D** | inline data URIs | every thumbnail base64'd into the payload — the anti-pattern |

## Measured results

Chromium, localhost, 20M rows server-side, 250k rows for the client-side modes,
`--seed 42`. Numbers move with hardware; the ratios are the point.

| mode | rows | wire (br) | decoded | first row | full load | worker decode | JS heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| A · paged JSON | 100 / window | **467 B** | — | **7 ms** | **7 ms** | — | 36 MB |
| B · NDJSON tuples | 250k | 5.4 MB | 12.0 MB | 169 ms | 372 ms | 339 ms | 37 MB |
| B2 · NDJSON objects | 250k | 8.2 MB | 39.0 MB | 115 ms | 504 ms | 469 ms | 37 MB |
| C · Arrow IPC | 250k | 4.6 MB | 8.2 MB | 61 ms | 201 ms | 167 ms | 38 MB |
| C · Arrow, brotli off | 250k | 8.2 MB | 8.2 MB | **22 ms** | **96 ms** | **64 ms** | 38 MB |
| D · data URIs | 10k | 1.4 MB | 22.4 MB | 77 ms | 163 ms | 135 ms | 39 MB |

DOM nodes stayed between 692 and 1,127 in every run, at every dataset size.

### What the numbers say

**Server-side windowing wins, and it is not close.** Mode A moves 467 bytes and finishes
in 7 ms against 20M rows. Every other mode is 10,000× the bytes and 15–70× the time to do
something the user cannot see. The rest of this table only matters if the dataset genuinely
must live in the browser — offline use, instant re-sort, pivots.

**Shape beats format, and both beat compression.** Arrow decodes 2.0× faster than NDJSON
tuples and 2.8× faster than NDJSON objects. But the tuples-vs-objects gap is itself 1.4×
with identical semantics — most of NDJSON's cost is allocating 250k objects and 2M values,
not parsing bytes. Dictionary-encoding the strings cut the decoded payload from 39 MB to
12 MB before any format change.

**Brotli cost more than it saved here.** Arrow with brotli: 4.6 MB and 201 ms. Without:
8.2 MB and 96 ms. On localhost the decompression CPU dominates; over a real network the
trade flips, which is exactly why the toggle exists rather than a default. Note also that
compression ratio tracks redundancy, not size — the data-URI payload compresses 16× because
512 images repeat, while high-entropy `f64` price columns compress 1.8×.

**Images are bounded by virtualisation, not by row count.** 20M rows, ~28 thumbnails on
screen, cache-hit rate climbing to 75% within one fling. A 512-image pool referenced by a
2-byte `image_id` costs nothing on the wire; the same images inlined as data URIs cost
2.24 KB *per row* — 68× Arrow's per-row cost, which extrapolates to roughly 45 GB at 20M
rows. That is what mode D is for.

## Traps hit while building this

Each of these produced a real, visible failure — they are load-bearing, not folklore.

- **`futures::stream::unfold` panics when polled after completion**, and `CompressionLayer`
  does exactly that. Uncompressed responses worked; compressed ones truncated mid-body with
  `Expected to read 116416 bytes for message body, but only read 0`. Both streams are
  `.fuse()`d.
- **SplitMix64 seeded per chunk by XOR produces overlapping streams.** Two chunks landed
  exactly 16γ apart and emitted byte-identical rows — different ids, every other column the
  same. Seeding is now counter-based (`hash2(seed, row_index)`), with a regression test.
- **Bytes counted during decode are post-decompression.** `fetch` undoes brotli before
  handing anything over, so counting there reports the uncompressed size and hides
  compression entirely. Real transfer comes from resource timing — and a worker's fetches
  land in the *worker's* timeline, not the page's. Arrow additionally needs a retry, because
  its reader stops at the end-of-stream marker a tick before the entry is recorded.
- **Browsers cap element height** (~33.5M px Chrome/Firefox, ~17.9M Safari). 20M rows × 44 px
  is 880M px, so the spacer is capped at 16M px and scroll position is scaled into row space.
  The cost is resolution: one pixel of drag covers ~55 rows, which is why there is a
  jump-to-row box. Past a few hundred thousand rows a scrollbar stops being a usable way to
  reach a position.
- **The instrument perturbed the experiment twice.** A HUD above the table pushed it down as
  numbers arrived (CLS 6.06), and toolbar controls appearing per-mode moved it again (CLS
  swinging 0.0005–0.54 by transport). The HUD now sits below the table and the toolbar keeps
  constant geometry; CLS is 0.0005–0.007 across all modes.
- **HTTP/1.1 caps a browser at 6 connections per origin, and h2c does not help** — browsers
  only negotiate HTTP/2 over TLS. Per-row thumbnails queue behind that limit on plain HTTP;
  the sprite atlas is the mitigation, not a server flag.
- **`Int64` is the one Arrow column JS cannot take for free.** It arrives as `BigInt64Array`
  and every value needs a `BigInt`→`Number` conversion. Worth knowing before adding a
  timestamp column.
- **An index permutation is 4 bytes per matched row.** At 20M rows one unfiltered permutation
  is 80 MB, so the query cache holds three entries, not eight.

## Design rules the code follows

- Columnar storage everywhere. `Vec<Row>` with owned `String` titles would cost ~600 MB at
  20M rows; struct-of-arrays with dictionary-encoded strings costs 650 MB at 20M and makes
  Arrow a near-verbatim dump of memory.
- Sorting permutes a `Vec<u32>` / `Uint32Array` of indices. Nothing ever copies rows.
- Nothing but binary crosses `postMessage` in bulk. A structured clone of an object graph
  costs about what parsing it cost, so window payloads are transferred typed arrays and only
  the ~60 visible rows ever become objects.
- Angular runs zoneless with `OnPush`; the dataset lives outside signals and only the visible
  window is reactive.
- Long work is chunked with `scheduler.yield()`, so a 250k-row filter never blocks input.

## Layout

```
backend/crates/core     dataset generation, columnar store, index query, procedural images
backend/crates/server   axum: paged JSON, NDJSON, Arrow IPC, data URIs, thumbnails, atlas
frontend/src/app/core   strategies (paged / worker), metrics service, data service
frontend/src/app/worker dataset owner: decode, sort, filter, window slicing
frontend/src/app/ui     virtual-scroll table, toolbar, HUD
docs/PLAN.md            the plan this was built from, with decisions
```

Backend: 20 tests (`cargo test`). Frontend: 6 tests (`npm test`).
