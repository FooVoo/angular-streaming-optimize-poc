import { Filters, RowVm, SortState } from './types';

export interface LoadResult {
  rows: number;
  matched: number;
  /** Transferred bytes, compression included. */
  bytes: number;
  /** Bytes fed to the decoder, i.e. after the browser undid brotli. */
  decodedBytes: number;
  uncompressedBytes: number;
  decodeMs: number;
  firstRowMs: number;
}

/**
 * One interface, two strategies: keep the dataset on the server and window it, or
 * ship it once and window it in a worker. Everything the table does goes through
 * here so the two are measured under identical rendering conditions.
 */
export interface RowSource {
  /** True when the whole dataset lives in the browser. */
  readonly clientSide: boolean;
  load(filters: Filters, sort: SortState | null, limit: number, compressed: boolean): Promise<LoadResult>;
  window(offset: number, count: number): Promise<RowVm[]>;
  sort(sort: SortState): Promise<number>;
  filter(filters: Filters): Promise<{ ms: number; matched: number }>;
  dispose(): void;
  onProgress?: (loaded: number, bytes: number) => void;
  onFirstRow?: (elapsedMs: number) => void;
}
