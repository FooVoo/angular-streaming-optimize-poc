/**
 * Worker protocol.
 *
 * Rule the whole design hangs on: nothing but binary crosses `postMessage` in
 * bulk. A structured clone of an object graph costs roughly what parsing it cost,
 * so sending rows as objects would hand back everything the worker just saved.
 * Window payloads are typed arrays, transferred (O(1)), not copied.
 */

export type WorkerMode = 'ndjson' | 'ndjson-object' | 'arrow' | 'datauri';

export interface LoadRequest {
  type: 'load';
  id: number;
  mode: WorkerMode;
  url: string;
  /** Needed by object-shape NDJSON to map strings back to dictionary indices. */
  titleDict?: string[];
  categories: string[];
  statuses: string[];
}

export interface WindowRequest {
  type: 'window';
  id: number;
  offset: number;
  count: number;
}

export interface SortRequest {
  type: 'sort';
  id: number;
  key: string;
  desc: boolean;
}

export interface FilterRequest {
  type: 'filter';
  id: number;
  q: string;
  status: number | null;
  category: number | null;
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export type WorkerRequest =
  | LoadRequest
  | WindowRequest
  | SortRequest
  | FilterRequest
  | CancelRequest;

export interface WireColumns {
  id: Uint32Array;
  createdAt: Float64Array;
  titleIdx: Uint32Array;
  categoryIdx: Uint16Array;
  status: Uint8Array;
  price: Float64Array;
  qty: Int32Array;
  active: Uint8Array;
  imageId: Uint16Array;
  /** Only populated by the data-URI mode, which is the anti-pattern on purpose. */
  thumbs?: string[];
}

export interface ProgressMessage {
  type: 'progress';
  loaded: number;
  bytes: number;
  elapsedMs: number;
}

export interface FirstRowMessage {
  type: 'firstRow';
  elapsedMs: number;
}

export interface LoadedMessage {
  type: 'loaded';
  id: number;
  rows: number;
  matched: number;
  /** Bytes actually transferred, compression included. From resource timing. */
  bytes: number;
  /** Bytes the decoder consumed, i.e. after the browser undid brotli. */
  decodedBytes: number;
  decodeMs: number;
  uncompressedBytes: number;
}

export interface WindowMessage {
  type: 'window';
  id: number;
  offset: number;
  count: number;
  cols: WireColumns;
}

export interface OpDoneMessage {
  type: 'sorted' | 'filtered';
  id: number;
  ms: number;
  matched: number;
}

export interface ErrorMessage {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerResponse =
  | ProgressMessage
  | FirstRowMessage
  | LoadedMessage
  | WindowMessage
  | OpDoneMessage
  | ErrorMessage;
