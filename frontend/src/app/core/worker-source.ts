import {
  OpDoneMessage,
  WindowMessage,
  WorkerRequest,
  WorkerResponse,
} from '../worker/protocol';
import { streamUrl } from './api';
import { LoadResult, RowSource } from './row-source';
import { Filters, Meta, Mode, RowVm, SortState } from './types';

/**
 * Modes B/C/D — the dataset is streamed into a worker and stays there.
 *
 * The main thread holds no rows at all: it asks for an offset and gets typed
 * arrays back by transfer, then builds ~60 view objects for the template. Sorting
 * and filtering never touch the UI thread.
 */
export class WorkerSource implements RowSource {
  readonly clientSide = true;
  private readonly worker: Worker;
  private readonly pending = new Map<number, (value: never) => void>();
  private readonly rejecters = new Map<number, (reason: Error) => void>();
  private nextId = 1;
  private filters: Filters = { q: '', status: null, category: null };
  private sortState: SortState | null = null;

  onProgress?: (loaded: number, bytes: number) => void;
  onFirstRow?: (elapsedMs: number) => void;

  constructor(
    private readonly mode: Mode,
    private readonly meta: Meta,
    private readonly titleDict: string[],
  ) {
    this.worker = new Worker(new URL('../worker/data.worker', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) =>
      this.receive(event.data),
    );
  }

  async load(
    filters: Filters,
    sort: SortState | null,
    limit: number,
    compressed: boolean,
  ): Promise<LoadResult> {
    this.filters = filters;
    this.sortState = sort;
    const url = streamUrl(this.mode, filters, sort, limit, compressed);
    const started = performance.now();
    let firstRowMs = 0;
    const seenFirstRow = (elapsed: number) => {
      firstRowMs = elapsed;
    };
    const previous = this.onFirstRow;
    this.onFirstRow = (elapsed) => {
      seenFirstRow(elapsed);
      previous?.(elapsed);
    };

    const result = await this.request<{
      rows: number;
      matched: number;
      bytes: number;
      decodedBytes: number;
      uncompressedBytes: number;
      decodeMs: number;
    }>((id) => ({
      type: 'load',
      id,
      mode: this.mode === 'ndjson-object' ? 'ndjson-object' : (this.mode as never),
      url,
      // The dictionary is only needed to undo the denormalised object shape.
      titleDict: this.mode === 'ndjson-object' ? this.titleDict : undefined,
      categories: this.meta.categories,
      statuses: this.meta.statuses,
    }));

    this.onFirstRow = previous;
    return {
      ...result,
      firstRowMs: firstRowMs || performance.now() - started,
    };
  }

  async window(offset: number, count: number): Promise<RowVm[]> {
    const message = await this.request<WindowMessage>((id) => ({
      type: 'window',
      id,
      offset,
      count,
    }));
    const cols = message.cols;
    const out: RowVm[] = new Array(message.count);
    for (let i = 0; i < message.count; i++) {
      out[i] = {
        index: message.offset + i,
        id: cols.id[i],
        createdAt: cols.createdAt[i],
        title: this.titleDict[cols.titleIdx[i]] ?? `#${cols.titleIdx[i]}`,
        category: this.meta.categories[cols.categoryIdx[i]] ?? '',
        status: this.meta.statuses[cols.status[i]] ?? '',
        price: cols.price[i],
        qty: cols.qty[i],
        active: cols.active[i] === 1,
        imageId: cols.imageId[i],
        thumb: cols.thumbs?.[i],
      };
    }
    return out;
  }

  async sort(sort: SortState): Promise<number> {
    this.sortState = sort;
    const done = await this.request<OpDoneMessage>((id) => ({
      type: 'sort',
      id,
      key: sort.key,
      desc: sort.desc,
    }));
    return done.ms;
  }

  async filter(filters: Filters): Promise<{ ms: number; matched: number }> {
    this.filters = filters;
    const done = await this.request<OpDoneMessage>((id) => ({
      type: 'filter',
      id,
      q: filters.q,
      status: filters.status,
      category: filters.category,
    }));
    return { ms: done.ms, matched: done.matched };
  }

  dispose(): void {
    this.worker.postMessage({ type: 'cancel', id: 0 } satisfies WorkerRequest);
    this.worker.terminate();
    for (const reject of this.rejecters.values()) reject(new Error('disposed'));
    this.pending.clear();
    this.rejecters.clear();
  }

  private request<T>(build: (id: number) => WorkerRequest): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, resolve as (value: never) => void);
      this.rejecters.set(id, reject);
      this.worker.postMessage(build(id));
    });
  }

  private receive(message: WorkerResponse): void {
    switch (message.type) {
      case 'progress':
        this.onProgress?.(message.loaded, message.bytes);
        return;
      case 'firstRow':
        this.onFirstRow?.(message.elapsedMs);
        return;
      case 'error': {
        this.rejecters.get(message.id)?.(new Error(message.message));
        this.settle(message.id);
        return;
      }
      default: {
        const resolve = this.pending.get(message.id);
        resolve?.(message as never);
        this.settle(message.id);
      }
    }
  }

  private settle(id: number): void {
    this.pending.delete(id);
    this.rejecters.delete(id);
  }
}
