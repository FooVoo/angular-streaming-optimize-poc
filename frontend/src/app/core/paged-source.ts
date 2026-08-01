import { API, queryString } from './api';
import { LoadResult, RowSource } from './row-source';
import { Filters, RowVm, SortState } from './types';

interface PagedResponse {
  total: number;
  matched: number;
  offset: number;
  limit: number;
  rows: {
    id: number;
    created_at: number;
    title: string;
    category: string;
    status: string;
    price: number;
    qty: number;
    active: boolean;
    image_id: number;
  }[];
}

/**
 * Mode A — server-side window.
 *
 * The baseline, and per the cost analysis the one that should win: sorting and
 * filtering happen where the data already is, and the browser only ever sees a
 * screen's worth. Everything else in this POC only matters when the full dataset
 * genuinely has to live client-side.
 */
export class PagedSource implements RowSource {
  readonly clientSide = false;
  private filters: Filters = { q: '', status: null, category: null };
  private sortState: SortState | null = null;
  private compressed = true;
  private inFlight: AbortController | null = null;

  onProgress?: (loaded: number, bytes: number) => void;
  onFirstRow?: (elapsedMs: number) => void;

  async load(
    filters: Filters,
    sort: SortState | null,
    _limit: number,
    compressed: boolean,
  ): Promise<LoadResult> {
    this.filters = filters;
    this.sortState = sort;
    this.compressed = compressed;
    const started = performance.now();
    // One row is enough to learn the matched count and prime the server's cached
    // index permutation for the pages that follow.
    const probe = await this.fetchPage(0, 1);
    const elapsed = performance.now() - started;
    this.onFirstRow?.(elapsed);
    return {
      rows: 0,
      matched: probe.matched,
      // Main-thread fetches show up in the page's resource timeline, so the
      // service reads the real transfer from there instead of guessing here.
      bytes: 0,
      decodedBytes: 0,
      uncompressedBytes: 0,
      decodeMs: 0,
      firstRowMs: elapsed,
    };
  }

  async window(offset: number, count: number): Promise<RowVm[]> {
    const page = await this.fetchPage(offset, count);
    return page.rows.map((row, i) => ({
      index: offset + i,
      id: row.id,
      createdAt: row.created_at,
      title: row.title,
      category: row.category,
      status: row.status,
      price: row.price,
      qty: row.qty,
      active: row.active,
      imageId: row.image_id,
    }));
  }

  async sort(sort: SortState): Promise<number> {
    this.sortState = sort;
    // The server sorts; cost shows up in the next window fetch, not here.
    return 0;
  }

  async filter(filters: Filters): Promise<{ ms: number; matched: number }> {
    this.filters = filters;
    const started = performance.now();
    const probe = await this.fetchPage(0, 1);
    return { ms: performance.now() - started, matched: probe.matched };
  }

  dispose(): void {
    this.inFlight?.abort();
  }

  private async fetchPage(offset: number, limit: number): Promise<PagedResponse> {
    // Scrolling fast produces overlapping page requests; only the newest matters.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const extra: Record<string, string | number> = { offset, limit };
    if (!this.compressed) extra['nobr'] = 1;
    const url = `${API}/rows?${queryString(this.filters, this.sortState, extra)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`rows: HTTP ${response.status}`);
    return response.json() as Promise<PagedResponse>;
  }
}
