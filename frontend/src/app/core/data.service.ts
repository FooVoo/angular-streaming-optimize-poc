import { Injectable, computed, inject, signal } from '@angular/core';

import { fetchMeta, fetchTitleDict } from './api';
import { MetricsService } from './metrics';
import { PagedSource } from './paged-source';
import { LoadResult, RowSource } from './row-source';
import {
  Filters,
  ImageMode,
  MAX_CLIENT_ROWS,
  Meta,
  Mode,
  RowVm,
  RunMetrics,
  SortState,
} from './types';
import { WorkerSource } from './worker-source';

/**
 * Owns the active strategy and the numbers each run produced. Deliberately the
 * only place that knows which mode is live, so components stay identical across
 * modes and comparisons stay honest.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly metrics = inject(MetricsService);

  readonly meta = signal<Meta | null>(null);
  readonly titleDict = signal<string[]>([]);
  readonly mode = signal<Mode>('paged');
  readonly imageMode = signal<ImageMode>('pool');
  readonly compressed = signal(true);
  readonly limit = signal(250_000);
  readonly filters = signal<Filters>({ q: '', status: null, category: null });
  readonly sort = signal<SortState | null>(null);

  readonly matched = signal(0);
  readonly loadedRows = signal(0);
  readonly loading = signal(false);
  readonly progressBytes = signal(0);
  readonly error = signal<string | null>(null);
  readonly rows = signal<RowVm[]>([]);
  readonly windowOffset = signal(0);
  readonly runs = signal<RunMetrics[]>([]);
  readonly lastSortMs = signal(0);
  readonly lastFilterMs = signal(0);
  /** Row the table should scroll to; bumped by the toolbar's jump box. */
  readonly jumpTo = signal<{ row: number; nonce: number } | null>(null);

  readonly ready = computed(() => this.meta() !== null);
  /** Rows the scroller must span. Client-side modes only hold what they streamed. */
  readonly virtualRows = computed(() =>
    this.source?.clientSide ? this.loadedRows() : this.matched(),
  );

  private source: RowSource | null = null;
  private windowToken = 0;

  async init(): Promise<void> {
    const [meta, dict] = await Promise.all([fetchMeta(), fetchTitleDict()]);
    this.meta.set(meta);
    this.titleDict.set(dict);
    this.limit.set(Math.min(meta.stream_cap, meta.rows, MAX_CLIENT_ROWS));
    if (meta.unique_images) this.imageMode.set('unique');
    await this.run();
  }

  /** Tear down the old strategy, build the new one, load, and record the run. */
  async run(): Promise<void> {
    const meta = this.meta();
    if (!meta) return;
    this.loading.set(true);
    this.error.set(null);
    this.rows.set([]);
    this.loadedRows.set(0);
    this.progressBytes.set(0);
    this.metrics.reset();

    this.source?.dispose();
    const mode = this.mode();
    const source: RowSource =
      mode === 'paged'
        ? new PagedSource()
        : new WorkerSource(mode, meta, this.titleDict());
    source.onProgress = (loaded, bytes) => {
      this.loadedRows.set(loaded);
      this.progressBytes.set(bytes);
    };
    this.source = source;

    const requested = mode === 'paged' ? meta.rows : this.limit();
    const started = performance.now();
    try {
      const result = await source.load(
        this.filters(),
        this.sort(),
        requested,
        this.compressed(),
      );
      this.matched.set(result.matched);
      this.loadedRows.set(source.clientSide ? result.rows : result.matched);
      const totalMs = performance.now() - started;
      await this.requestWindow(0, 60);
      this.recordRun(result, requested, totalMs);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  /** Nonce lets the same row be requested twice in a row and still fire. */
  jump(row: number): void {
    const clamped = Math.max(0, Math.min(row, this.virtualRows() - 1));
    this.jumpTo.update((current) => ({ row: clamped, nonce: (current?.nonce ?? 0) + 1 }));
  }

  async requestWindow(offset: number, count: number): Promise<void> {
    if (!this.source) return;
    const token = ++this.windowToken;
    try {
      const rows = await this.source.window(offset, count);
      // A slower earlier request must not overwrite a newer window.
      if (token !== this.windowToken) return;
      this.windowOffset.set(offset);
      this.rows.set(rows);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') this.error.set((error as Error).message);
    }
  }

  async applySort(key: string): Promise<void> {
    const current = this.sort();
    const next: SortState =
      current?.key === key ? { key, desc: !current.desc } : { key, desc: false };
    this.sort.set(next);
    if (!this.source) return;
    if (this.source.clientSide) {
      this.lastSortMs.set(await this.source.sort(next));
      await this.requestWindow(0, 60);
    } else {
      await this.source.sort(next);
      await this.requestWindow(0, 60);
    }
  }

  async applyFilters(filters: Filters): Promise<void> {
    this.filters.set(filters);
    if (!this.source) return;
    const result = await this.source.filter(filters);
    this.lastFilterMs.set(result.ms);
    this.matched.set(result.matched);
    if (this.source.clientSide) this.loadedRows.set(result.matched);
    await this.requestWindow(0, 60);
  }

  private recordRun(
    result: LoadResult,
    requested: number,
    totalMs: number,
  ): void {
    const run: RunMetrics = {
      mode: this.mode(),
      imageMode: this.imageMode(),
      rowsRequested: requested,
      rowsLoaded: result.rows,
      matched: result.matched,
      compressed: this.compressed(),
      timeToFirstRowMs: Math.round(result.firstRowMs),
      timeToFullMs: Math.round(totalMs),
      decodeMs: Math.round(result.decodeMs),
      wireBytes: result.bytes || this.metrics.rowWireBytes(),
      decodedBytes: result.decodedBytes,
      uncompressedBytes: result.uncompressedBytes,
      longTasks: this.metrics.longTasks(),
      longTaskMs: this.metrics.longTaskMs(),
      maxLongTaskMs: this.metrics.maxLongTaskMs(),
      inpMs: this.metrics.inpMs(),
      cls: this.metrics.cls(),
      jsHeapMb: this.metrics.jsHeapMb(),
      domNodes: this.metrics.domNodes(),
      imageRequests: this.metrics.imageRequests(),
      imageCacheHits: this.metrics.imageCacheHits(),
      imageBytes: this.metrics.imageBytes(),
      sortMs: this.lastSortMs(),
      filterMs: this.lastFilterMs(),
      at: new Date().toISOString(),
    };
    this.runs.update((runs) => [run, ...runs].slice(0, 40));
  }

  exportRuns(): void {
    const blob = new Blob([JSON.stringify(this.runs(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'streaming-poc-runs.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
