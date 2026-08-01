# Plan — angular-streaming-optimize-poc

Status: **built and measured**. Results live in the root `README.md`.

## Thesis

A grid showing millions of rows feels slow for reasons that rank in a fixed order:
DOM/change detection first, object allocation second, parse third, wire size last.
Optimising bottom-up is the common mistake — WASM cores and Protobuf wire formats get
adopted to fix a problem that lives in the render path, where neither has any effect.

This POC is that ranking made executable: four transports, one renderer, one HUD.

## Decisions taken

| # | decision | why |
|---|---|---|
| 1 | Client-side modes capped (250k default, 2M ceiling); server holds 20M | columns cost ~34 B/row in the worker — 20M would be ~680 MB of typed arrays and a dead tab. Mode A is unaffected, which is itself the finding |
| 2 | Apache Arrow over hand-rolled binary frames | realistic, schema and nulls for free, and bundle size is not what this measures. It lands in the worker chunk (44.6 kB), not the main bundle |
| 3 | No persistence — regenerate in memory at boot | 220 ms for 20M rows. A database would add a phase and measure Postgres instead of the render path |
| 4 | 512-image pool + atlas + data-URI demo + `--unique-images` | pooled `<img>` is the realistic default; the other three exist to make the cost curve visible rather than asserted |

## Phases

1. ✅ repo scaffold, workspace, gitignore
2. ✅ `poc-core`: columnar store, deterministic generator, index sort/filter, procedural images
3. ✅ `poc-server`: meta, dictionary, paged JSON, stats, PATCH
4. ✅ Angular shell, virtual-scroll table, mode A end to end
5. ✅ NDJSON stream + worker (modes B, B2)
6. ✅ Arrow IPC + zero-copy typed arrays (mode C)
7. ✅ HUD, comparison runs, results written up

## Corrections made during the build

- **h2c was proposed to work around the HTTP/1.1 6-connection cap. It does not** — browsers
  only negotiate HTTP/2 over TLS. Documented as a real constraint; the sprite atlas is the
  mitigation.
- **CDK virtual scroll was planned, then dropped.** `cdkVirtualForOf` needs a `DataSource`
  whose array indices align with the full list, meaning a 20M-element array — precisely the
  per-row allocation this POC argues against. Hand-rolled instead, which also allowed the
  spacer-height cap the browser's element-height limit requires.
- **Default row count raised from 3M to 20M**, which forced the client-side ceiling
  (decision 1) and shrank the query cache from 8 slots to 3 (80 MB per permutation).

## Not built

- TLS, so no HTTP/2 in the browser and no measurement of thumbnails without the
  6-connection cap. `--tls` is the obvious next flag.
- WASM decode path (`prost`/`arrow-rs` in linear memory). The note's ranking puts it below
  everything measured here; worth adding only if a mode-C run shows decode still dominating
  on target hardware.
- `SharedArrayBuffer` / cross-origin isolation, which would remove even the transfer cost —
  it requires COOP/COEP and breaks third-party iframes.
