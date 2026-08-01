/// <reference lib="webworker" />

import { RecordBatchReader } from 'apache-arrow';

import type {
  WireColumns,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

/**
 * Owns the dataset. The main thread never sees it — it asks for a 60-row window
 * and gets typed arrays back. Sorting and filtering happen here too, so a 250k-row
 * re-sort never touches the frame that is trying to paint.
 */

interface Columns {
  id: Uint32Array;
  createdAt: Float64Array;
  titleIdx: Uint32Array;
  categoryIdx: Uint16Array;
  status: Uint8Array;
  price: Float64Array;
  qty: Int32Array;
  active: Uint8Array;
  imageId: Uint16Array;
  thumbs?: string[];
}

let cols: Columns | null = null;
/** Row count actually decoded. */
let loaded = 0;
/** Index permutation: what the table walks. Sorting reorders this, not the data. */
let order = new Uint32Array(0);
let titleDict: string[] = [];
let titleRank: Uint32Array | null = null;
let categories: string[] = [];
let statuses: string[] = [];
let abort: AbortController | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

function allocate(rows: number, withThumbs: boolean): Columns {
  return {
    id: new Uint32Array(rows),
    createdAt: new Float64Array(rows),
    titleIdx: new Uint32Array(rows),
    categoryIdx: new Uint16Array(rows),
    status: new Uint8Array(rows),
    price: new Float64Array(rows),
    qty: new Int32Array(rows),
    active: new Uint8Array(rows),
    imageId: new Uint16Array(rows),
    thumbs: withThumbs ? new Array<string>(rows) : undefined,
  };
}

/** Cooperative yield so a long decode never blocks input for more than a chunk. */
const yieldToScheduler = async (): Promise<void> => {
  const scheduler = (self as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function decodeNdjson(
  body: ReadableStream<Uint8Array>,
  objectShape: boolean,
  started: number,
): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const titleLookup = objectShape ? new Map(titleDict.map((t, i) => [t, i])) : null;
  const categoryLookup = objectShape ? new Map(categories.map((c, i) => [c, i])) : null;
  const statusLookup = objectShape ? new Map(statuses.map((s, i) => [s, i])) : null;

  let bytes = 0;
  let tail = '';
  let announcedFirstRow = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    const text = tail + decoder.decode(value, { stream: true });
    const lines = text.split('\n');
    // The last element is a partial line unless the chunk ended exactly on \n.
    tail = lines.pop() ?? '';

    for (const line of lines) {
      if (!line) continue;
      if (line.charCodeAt(0) === 123 /* { */) {
        if (objectShape) {
          const row = JSON.parse(line);
          if (row.kind === 'header') continue;
          const at = loaded++;
          cols!.id[at] = row.id;
          cols!.createdAt[at] = row.created_at;
          cols!.titleIdx[at] = titleLookup!.get(row.title) ?? 0;
          cols!.categoryIdx[at] = categoryLookup!.get(row.category) ?? 0;
          cols!.status[at] = statusLookup!.get(row.status) ?? 0;
          cols!.price[at] = row.price;
          cols!.qty[at] = row.qty;
          cols!.active[at] = row.active ? 1 : 0;
          cols!.imageId[at] = row.image_id;
          if (cols!.thumbs && row.thumb) cols!.thumbs[at] = row.thumb;
        }
        // Array shape: the only `{` line is the header, so skip it.
        continue;
      }
      const a = JSON.parse(line) as number[];
      const at = loaded++;
      cols!.id[at] = a[0];
      cols!.createdAt[at] = a[1];
      cols!.titleIdx[at] = a[2];
      cols!.categoryIdx[at] = a[3];
      cols!.status[at] = a[4];
      cols!.price[at] = a[5];
      cols!.qty[at] = a[6];
      cols!.active[at] = a[7];
      cols!.imageId[at] = a[8];
    }

    if (!announcedFirstRow && loaded > 0) {
      announcedFirstRow = true;
      post({ type: 'firstRow', elapsedMs: performance.now() - started });
    }
    post({ type: 'progress', loaded, bytes, elapsedMs: performance.now() - started });
    await yieldToScheduler();
  }
  return bytes;
}

async function decodeArrow(
  body: ReadableStream<Uint8Array>,
  started: number,
): Promise<number> {
  let bytes = 0;
  let announcedFirstRow = false;
  // Count wire bytes without disturbing the reader arrow needs.
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );

  const reader = await RecordBatchReader.from(counted);
  for await (const batch of reader) {
    const n = batch.numRows;
    const at = loaded;

    // Numeric columns come out as typed-array views straight over the received
    // buffer — no per-value work, no objects.
    cols!.id.set(batch.getChildAt(0)!.toArray() as Uint32Array, at);
    cols!.titleIdx.set(batch.getChildAt(2)!.toArray() as Uint32Array, at);
    cols!.categoryIdx.set(batch.getChildAt(3)!.toArray() as Uint16Array, at);
    cols!.status.set(batch.getChildAt(4)!.toArray() as Uint8Array, at);
    cols!.price.set(batch.getChildAt(5)!.toArray() as Float64Array, at);
    cols!.qty.set(batch.getChildAt(6)!.toArray() as Int32Array, at);
    cols!.imageId.set(batch.getChildAt(8)!.toArray() as Uint16Array, at);

    // Int64 is the one column JS cannot take for free: it arrives as BigInt64Array
    // and every value needs a BigInt->Number conversion. Measurable, and the
    // reason a timestamp column is worth thinking about before adding one.
    const ts = batch.getChildAt(1)!.toArray() as BigInt64Array;
    for (let i = 0; i < n; i++) cols!.createdAt[at + i] = Number(ts[i]);

    // Booleans arrive bit-packed; unpack straight from the validity buffer rather
    // than going through the (object-allocating) vector iterator.
    const boolData = batch.getChildAt(7)!.data[0];
    const bits = boolData.values as Uint8Array;
    const bitOffset = boolData.offset;
    for (let i = 0; i < n; i++) {
      const b = bitOffset + i;
      cols!.active[at + i] = (bits[b >> 3] >> (b & 7)) & 1;
    }

    loaded += n;
    if (!announcedFirstRow) {
      announcedFirstRow = true;
      post({ type: 'firstRow', elapsedMs: performance.now() - started });
    }
    post({ type: 'progress', loaded, bytes, elapsedMs: performance.now() - started });
    await yieldToScheduler();
  }
  return bytes;
}

/**
 * Real transferred size for a request this worker made.
 *
 * Bytes counted during decode are POST-decompression: the browser undoes brotli
 * before `fetch` hands anything over, so counting there reports the uncompressed
 * size and hides compression entirely. Resource timing is the only place the true
 * transfer shows up, and a worker's fetches land in the worker's own timeline.
 *
 * The retry matters for Arrow: its reader stops at the end-of-stream marker, which
 * can be a tick before the response is recorded as a resource entry. Reading once
 * silently fell back to the decoded size and made brotli look like a no-op.
 */
async function transferredBytes(url: string): Promise<number> {
  const absolute = new URL(url, self.location.origin).href;
  for (let attempt = 0; attempt < 12; attempt++) {
    const entry = performance
      .getEntriesByType('resource')
      .find((candidate) => candidate.name === absolute) as PerformanceResourceTiming | undefined;
    if (entry?.encodedBodySize) return entry.encodedBodySize;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 0;
}

async function load(request: Extract<WorkerRequest, { type: 'load' }>): Promise<void> {
  abort?.abort();
  abort = new AbortController();
  const started = performance.now();

  const response = await fetch(request.url, { signal: abort.signal });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  const sent = Number(response.headers.get('x-sent-rows') ?? 0);
  const matched = Number(response.headers.get('x-matched-rows') ?? sent);
  const uncompressed = Number(response.headers.get('x-uncompressed-bytes') ?? 0);

  titleDict = request.titleDict ?? titleDict;
  categories = request.categories;
  statuses = request.statuses;
  titleRank = null;

  loaded = 0;
  cols = allocate(sent, request.mode === 'datauri');

  const decodedBytes =
    request.mode === 'arrow'
      ? await decodeArrow(response.body, started)
      : await decodeNdjson(response.body, request.mode !== 'ndjson', started);

  const bytes = (await transferredBytes(request.url)) || decodedBytes;

  // Identity permutation: the server already applied the requested sort.
  order = new Uint32Array(loaded);
  for (let i = 0; i < loaded; i++) order[i] = i;

  post({
    type: 'loaded',
    id: request.id,
    rows: loaded,
    matched,
    bytes,
    decodedBytes,
    uncompressedBytes: uncompressed || decodedBytes,
    decodeMs: performance.now() - started,
  });
}

/** Lexicographic rank per dictionary entry, so title sorts compare integers. */
function ensureTitleRank(): Uint32Array {
  if (titleRank) return titleRank;
  const positions = new Uint32Array(titleDict.length);
  for (let i = 0; i < positions.length; i++) positions[i] = i;
  const sorted = Array.from(positions).sort((a, b) =>
    titleDict[a] < titleDict[b] ? -1 : titleDict[a] > titleDict[b] ? 1 : 0,
  );
  const rank = new Uint32Array(titleDict.length);
  for (let position = 0; position < sorted.length; position++) rank[sorted[position]] = position;
  titleRank = rank;
  return rank;
}

function sort(key: string, desc: boolean): number {
  const t0 = performance.now();
  if (!cols) return 0;
  const c = cols;
  let compare: (a: number, b: number) => number;
  switch (key) {
    case 'id':
      compare = (a, b) => c.id[a] - c.id[b];
      break;
    case 'created_at':
      compare = (a, b) => c.createdAt[a] - c.createdAt[b];
      break;
    case 'title': {
      const rank = ensureTitleRank();
      compare = (a, b) => rank[c.titleIdx[a]] - rank[c.titleIdx[b]];
      break;
    }
    case 'category':
      compare = (a, b) => c.categoryIdx[a] - c.categoryIdx[b];
      break;
    case 'status':
      compare = (a, b) => c.status[a] - c.status[b];
      break;
    case 'qty':
      compare = (a, b) => c.qty[a] - c.qty[b];
      break;
    case 'active':
      compare = (a, b) => c.active[a] - c.active[b];
      break;
    default:
      compare = (a, b) => c.price[a] - c.price[b];
  }
  // Sorting the permutation, never the columns.
  order.sort(desc ? (a, b) => compare(b, a) : compare);
  return performance.now() - t0;
}

async function filter(
  q: string,
  status: number | null,
  category: number | null,
): Promise<{ ms: number; matched: number }> {
  const t0 = performance.now();
  if (!cols) return { ms: 0, matched: 0 };

  const needle = q.trim().toLowerCase();
  // Match against the 50k-entry dictionary, then compare integers per row.
  let titleHits: Uint8Array | null = null;
  if (needle) {
    titleHits = new Uint8Array(titleDict.length);
    for (let i = 0; i < titleDict.length; i++) {
      titleHits[i] = titleDict[i].toLowerCase().includes(needle) ? 1 : 0;
    }
  }

  const next = new Uint32Array(loaded);
  let n = 0;
  const CHUNK = 100_000;
  for (let start = 0; start < loaded; start += CHUNK) {
    const end = Math.min(start + CHUNK, loaded);
    for (let i = start; i < end; i++) {
      if (titleHits && !titleHits[cols.titleIdx[i]]) continue;
      if (status !== null && cols.status[i] !== status) continue;
      if (category !== null && cols.categoryIdx[i] !== category) continue;
      next[n++] = i;
    }
    // Any task over ~50 ms blocks input; chunk-and-yield keeps the table clickable
    // while a 250k-row filter runs.
    if (end < loaded) await yieldToScheduler();
  }
  order = next.subarray(0, n);
  return { ms: performance.now() - t0, matched: n };
}

function windowOf(id: number, offset: number, count: number): void {
  if (!cols) return;
  const start = Math.max(0, Math.min(offset, order.length));
  const n = Math.max(0, Math.min(count, order.length - start));
  const out: WireColumns = {
    id: new Uint32Array(n),
    createdAt: new Float64Array(n),
    titleIdx: new Uint32Array(n),
    categoryIdx: new Uint16Array(n),
    status: new Uint8Array(n),
    price: new Float64Array(n),
    qty: new Int32Array(n),
    active: new Uint8Array(n),
    imageId: new Uint16Array(n),
    thumbs: cols.thumbs ? new Array<string>(n) : undefined,
  };
  for (let i = 0; i < n; i++) {
    const r = order[start + i];
    out.id[i] = cols.id[r];
    out.createdAt[i] = cols.createdAt[r];
    out.titleIdx[i] = cols.titleIdx[r];
    out.categoryIdx[i] = cols.categoryIdx[r];
    out.status[i] = cols.status[r];
    out.price[i] = cols.price[r];
    out.qty[i] = cols.qty[r];
    out.active[i] = cols.active[r];
    out.imageId[i] = cols.imageId[r];
    if (out.thumbs && cols.thumbs) out.thumbs[i] = cols.thumbs[r];
  }
  // Transfer, don't clone: the buffers leave this thread by pointer.
  post({ type: 'window', id, offset: start, count: n, cols: out }, [
    out.id.buffer,
    out.createdAt.buffer,
    out.titleIdx.buffer,
    out.categoryIdx.buffer,
    out.status.buffer,
    out.price.buffer,
    out.qty.buffer,
    out.active.buffer,
    out.imageId.buffer,
  ]);
}

addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.type) {
        case 'load':
          await load(request);
          break;
        case 'window':
          windowOf(request.id, request.offset, request.count);
          break;
        case 'sort': {
          const ms = sort(request.key, request.desc);
          post({ type: 'sorted', id: request.id, ms, matched: order.length });
          break;
        }
        case 'filter': {
          const result = await filter(request.q, request.status, request.category);
          post({
            type: 'filtered',
            id: request.id,
            ms: result.ms,
            matched: result.matched,
          });
          break;
        }
        case 'cancel':
          abort?.abort();
          break;
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      post({ type: 'error', id: request.id, message: (error as Error).message });
    }
  })();
});
