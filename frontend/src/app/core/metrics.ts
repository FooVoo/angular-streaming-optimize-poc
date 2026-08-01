import { Injectable, signal } from '@angular/core';

/**
 * The measurement layer — the actual deliverable of this POC.
 *
 * Split the cost three ways (network / decode / render) instead of quoting one
 * "load time" number, because the three respond to completely different fixes and
 * on a fast link the render column usually dominates the other two combined.
 */
@Injectable({ providedIn: 'root' })
export class MetricsService {
  readonly longTasks = signal(0);
  readonly longTaskMs = signal(0);
  readonly maxLongTaskMs = signal(0);
  readonly inpMs = signal(0);
  readonly cls = signal(0);
  readonly imageRequests = signal(0);
  readonly imageCacheHits = signal(0);
  readonly imageBytes = signal(0);
  readonly rowWireBytes = signal(0);
  readonly supported = signal({ longtask: false, event: false, layoutShift: false });

  constructor() {
    this.observe('longtask', (entries) => {
      let count = this.longTasks();
      let total = this.longTaskMs();
      let max = this.maxLongTaskMs();
      for (const entry of entries) {
        count++;
        total += entry.duration;
        max = Math.max(max, entry.duration);
      }
      this.longTasks.set(count);
      this.longTaskMs.set(Math.round(total));
      this.maxLongTaskMs.set(Math.round(max));
    }) && this.supported.update((s) => ({ ...s, longtask: true }));

    // INP, not load time: what a user feels on a grid is interaction latency.
    this.observe(
      'event',
      (entries) => {
        let worst = this.inpMs();
        for (const entry of entries) worst = Math.max(worst, entry.duration);
        this.inpMs.set(Math.round(worst));
      },
      { durationThreshold: 40 },
    ) && this.supported.update((s) => ({ ...s, event: true }));

    this.observe('layout-shift', (entries) => {
      let total = this.cls();
      for (const entry of entries as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) total += entry.value;
      }
      this.cls.set(Number(total.toFixed(4)));
    }) && this.supported.update((s) => ({ ...s, layoutShift: true }));

    this.observe('resource', (entries) => {
      let requests = this.imageRequests();
      let hits = this.imageCacheHits();
      let bytes = this.imageBytes();
      let rowBytes = this.rowWireBytes();
      for (const entry of entries as unknown as PerformanceResourceTiming[]) {
        if (entry.name.includes('/api/thumb') || entry.name.includes('/api/atlas')) {
          requests++;
          bytes += entry.encodedBodySize;
          // A served-from-cache response reports zero transfer with a non-zero body.
          if (entry.transferSize === 0 && entry.decodedBodySize > 0) hits++;
        } else if (entry.name.includes('/api/rows')) {
          rowBytes += entry.transferSize || entry.encodedBodySize;
        }
      }
      this.imageRequests.set(requests);
      this.imageCacheHits.set(hits);
      this.imageBytes.set(bytes);
      this.rowWireBytes.set(rowBytes);
    });
  }

  private observe(
    type: string,
    handler: (entries: PerformanceEntryList) => void,
    options: Record<string, unknown> = {},
  ): boolean {
    try {
      const observer = new PerformanceObserver((list) => handler(list.getEntries()));
      observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
      return true;
    } catch {
      return false;
    }
  }

  /** Clear per-run counters. Support flags and observers stay live. */
  reset(): void {
    this.longTasks.set(0);
    this.longTaskMs.set(0);
    this.maxLongTaskMs.set(0);
    this.inpMs.set(0);
    this.cls.set(0);
    this.imageRequests.set(0);
    this.imageCacheHits.set(0);
    this.imageBytes.set(0);
    this.rowWireBytes.set(0);
  }

  jsHeapMb(): number {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? Math.round(memory.usedJSHeapSize / 1_048_576) : 0;
  }

  domNodes(): number {
    return document.getElementsByTagName('*').length;
  }
}
