import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { DataService } from '../core/data.service';
import { MetricsService } from '../core/metrics';

/**
 * The scoreboard. Network, decode and render are kept apart on purpose — a single
 * "load time" number hides which of the three is actually the problem, and they
 * respond to completely different fixes.
 */
@Component({
  selector: 'app-hud',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hud">
      <section>
        <h3>network</h3>
        <div class="stat"><span>wire (br)</span><b>{{ mb(wireBytes()) }}</b></div>
        <div class="stat"><span>decoded</span><b>{{ mb(run()?.decodedBytes ?? 0) }}</b></div>
        <div class="stat"><span>rows loaded</span><b>{{ int(data.loadedRows()) }}</b></div>
        <div class="stat"><span>matched</span><b>{{ int(data.matched()) }}</b></div>
      </section>

      <section>
        <h3>decode</h3>
        <div class="stat"><span>first row</span><b>{{ ms(run()?.timeToFirstRowMs) }}</b></div>
        <div class="stat"><span>full load</span><b>{{ ms(run()?.timeToFullMs) }}</b></div>
        <div class="stat"><span>worker decode</span><b>{{ ms(run()?.decodeMs) }}</b></div>
        <div class="stat"><span>sort / filter</span><b>{{ ms(data.lastSortMs()) }} / {{ ms(data.lastFilterMs()) }}</b></div>
      </section>

      <section>
        <h3>render</h3>
        <div class="stat" [class.bad]="metrics.maxLongTaskMs() > 50">
          <span>long tasks</span><b>{{ metrics.longTasks() }} · {{ ms(metrics.longTaskMs()) }}</b>
        </div>
        <div class="stat" [class.bad]="metrics.maxLongTaskMs() > 200">
          <span>worst task</span><b>{{ ms(metrics.maxLongTaskMs()) }}</b>
        </div>
        <div class="stat" [class.bad]="metrics.inpMs() > 200"><span>INP</span><b>{{ ms(metrics.inpMs()) }}</b></div>
        <div class="stat" [class.bad]="metrics.cls() > 0.1"><span>CLS</span><b>{{ metrics.cls() }}</b></div>
        <div class="stat"><span>DOM nodes</span><b>{{ int(domNodes()) }}</b></div>
        <div class="stat"><span>JS heap</span><b>{{ heap() }}</b></div>
      </section>

      <section>
        <h3>images</h3>
        <div class="stat"><span>requests</span><b>{{ int(metrics.imageRequests()) }}</b></div>
        <div class="stat"><span>cache hits</span><b>{{ cacheHitRate() }}</b></div>
        <div class="stat"><span>bytes</span><b>{{ mb(metrics.imageBytes()) }}</b></div>
        <div class="stat"><span>mode</span><b>{{ data.imageMode() }}</b></div>
      </section>

      <section class="server">
        <h3>server</h3>
        <div class="stat"><span>rows</span><b>{{ int(data.meta()?.rows ?? 0) }}</b></div>
        <div class="stat"><span>generated in</span><b>{{ ms(data.meta()?.generate_ms) }}</b></div>
        <div class="stat"><span>resident</span><b>{{ mb(data.meta()?.server_heap_bytes ?? 0) }}</b></div>
        <div class="stat"><span>seed</span><b>{{ data.meta()?.seed }}</b></div>
      </section>
    </div>

    @if (data.runs().length > 1) {
      <details class="history">
        <summary>{{ data.runs().length }} recorded runs</summary>
        <table>
          <thead>
            <tr>
              <th>mode</th><th>images</th><th>rows</th><th>br</th>
              <th>first row</th><th>full</th><th>decode</th><th>wire</th>
              <th>long tasks</th><th>worst</th><th>heap</th><th>DOM</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of data.runs(); track entry.at) {
              <tr>
                <td>{{ entry.mode }}</td>
                <td>{{ entry.imageMode }}</td>
                <td class="num">{{ int(entry.rowsLoaded || entry.matched) }}</td>
                <td>{{ entry.compressed ? 'br' : '—' }}</td>
                <td class="num">{{ ms(entry.timeToFirstRowMs) }}</td>
                <td class="num">{{ ms(entry.timeToFullMs) }}</td>
                <td class="num">{{ ms(entry.decodeMs) }}</td>
                <td class="num">{{ mb(entry.wireBytes) }}</td>
                <td class="num">{{ entry.longTasks }}</td>
                <td class="num">{{ ms(entry.maxLongTaskMs) }}</td>
                <td class="num">{{ entry.jsHeapMb }} MB</td>
                <td class="num">{{ entry.domNodes }}</td>
              </tr>
            }
          </tbody>
        </table>
      </details>
    }
  `,
  styles: `
    .hud {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      /* Reserve the tallest section's height so filling in values never reflows. */
      min-height: 146px;
    }
    h3 {
      margin: 0 0 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 600;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 12.5px;
      padding: 2px 0;
    }
    .stat span {
      color: var(--muted);
    }
    .stat b {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .stat.bad b {
      color: #ff8a7a;
    }
    .history {
      margin-top: 10px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
    }
    summary {
      cursor: pointer;
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }
    th,
    td {
      text-align: left;
      padding: 4px 6px;
      border-bottom: 1px solid var(--line-soft);
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-weight: 600;
    }
    td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class HudComponent {
  readonly data = inject(DataService);
  readonly metrics = inject(MetricsService);

  readonly run = computed(() => this.data.runs()[0] ?? null);
  readonly wireBytes = computed(
    () => this.run()?.wireBytes || this.data.progressBytes(),
  );

  cacheHitRate(): string {
    const requests = this.metrics.imageRequests();
    if (!requests) return '—';
    return `${Math.round((this.metrics.imageCacheHits() / requests) * 100)}%`;
  }

  domNodes(): number {
    return this.metrics.domNodes();
  }

  heap(): string {
    const mb = this.metrics.jsHeapMb();
    return mb ? `${mb} MB` : 'n/a';
  }

  ms(value: number | undefined): string {
    if (value === undefined || value === null) return '—';
    return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  }

  mb(bytes: number): string {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  int(value: number): string {
    return value.toLocaleString('en-US');
  }
}
