/**
 * Ceiling for the client-side modes.
 *
 * Columns cost ~34 bytes per row in the worker, so 2M is already ~68 MB of typed
 * arrays plus the same again in flight. The server holds 20M happily; the browser
 * does not, and pretending otherwise would just crash the tab instead of making a
 * point. Mode A is unaffected — it never holds more than a screen.
 */
export const MAX_CLIENT_ROWS = 2_000_000;

/** Transport under test. */
export type Mode = 'paged' | 'ndjson' | 'ndjson-object' | 'arrow' | 'datauri';

/** How the thumbnail column gets its pixels. */
export type ImageMode = 'pool' | 'atlas' | 'unique' | 'none';

export interface ColumnMeta {
  key: string;
  label: string;
  type: 'int' | 'dict' | 'enum' | 'money' | 'date' | 'bool' | 'image';
  width: number;
}

export interface AtlasMeta {
  count: number;
  cell: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
  colors: string[];
}

export interface Meta {
  rows: number;
  seed: number;
  server_heap_bytes: number;
  generate_ms: number;
  images_ms: number;
  stream_cap: number;
  unique_images: boolean;
  title_dict_len: number;
  categories: string[];
  statuses: string[];
  atlas: AtlasMeta;
  columns: ColumnMeta[];
}

export interface Filters {
  q: string;
  status: number | null;
  category: number | null;
}

export interface SortState {
  key: string;
  desc: boolean;
}

/**
 * A row as the template sees it. Only ever created for the ~60 rows on screen —
 * never for the dataset. Building three million of these is the thing this whole
 * POC exists to avoid.
 */
export interface RowVm {
  index: number;
  id: number;
  createdAt: number;
  title: string;
  category: string;
  status: string;
  price: number;
  qty: number;
  active: boolean;
  imageId: number;
  thumb?: string;
}

export interface RunMetrics {
  mode: Mode;
  imageMode: ImageMode;
  rowsRequested: number;
  rowsLoaded: number;
  matched: number;
  compressed: boolean;
  timeToFirstRowMs: number;
  timeToFullMs: number;
  decodeMs: number;
  /** Transferred bytes (post-compression). */
  wireBytes: number;
  /** Bytes handed to the decoder (post-decompression). */
  decodedBytes: number;
  uncompressedBytes: number;
  longTasks: number;
  longTaskMs: number;
  maxLongTaskMs: number;
  inpMs: number;
  cls: number;
  jsHeapMb: number;
  domNodes: number;
  imageRequests: number;
  imageCacheHits: number;
  imageBytes: number;
  sortMs: number;
  filterMs: number;
  at: string;
}
