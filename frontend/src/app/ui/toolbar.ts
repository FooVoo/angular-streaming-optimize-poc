import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { DataService } from '../core/data.service';
import { ImageMode, MAX_CLIENT_ROWS, Mode } from '../core/types';

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'paged', label: 'A · paged JSON', hint: 'server windows, 100 rows per request' },
  { value: 'ndjson', label: 'B · NDJSON stream', hint: 'dictionary-indexed tuples, worker-parsed' },
  {
    value: 'ndjson-object',
    label: 'B2 · NDJSON objects',
    hint: 'denormalised rows — the naive shape',
  },
  { value: 'arrow', label: 'C · Arrow IPC', hint: 'columnar, zero-copy typed arrays' },
  { value: 'datauri', label: 'D · inline data URIs', hint: 'anti-pattern, capped at 10k rows' },
];

const IMAGE_MODES: { value: ImageMode; label: string }[] = [
  { value: 'pool', label: 'pooled <img>' },
  { value: 'atlas', label: 'sprite atlas' },
  { value: 'unique', label: 'per-row (cache miss)' },
  { value: 'none', label: 'no images' },
];

@Component({
  selector: 'app-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <label>
        Transport
        <select [value]="data.mode()" (change)="setMode($event)">
          @for (mode of modes; track mode.value) {
            <option [value]="mode.value">{{ mode.label }}</option>
          }
        </select>
      </label>

      <label>
        Images
        <select [value]="data.imageMode()" (change)="setImageMode($event)">
          @for (mode of imageModes; track mode.value) {
            <option [value]="mode.value">{{ mode.label }}</option>
          }
        </select>
      </label>

      <!-- Always rendered, disabled when inapplicable: a control that appears and
           disappears between modes changes the toolbar's height, moves the table
           below it, and shows up as layout shift in the very metric this page
           reports. Constant geometry is a measurement requirement here. -->
      <label [class.dim]="!clientSide()">
        Rows
        <input
          class="rows-input"
          type="number"
          min="1000"
          step="1000"
          [value]="data.limit()"
          [disabled]="!clientSide()"
          (change)="setLimit($event)"
        />
      </label>
      <button
        class="ghost"
        (click)="loadEverything()"
        [disabled]="data.loading() || data.mode() !== 'arrow'"
        title="Client-side ceiling — the server holds far more than the browser can"
      >
        load {{ clientCapM() }}M (client cap)
      </button>

      <label>
        Jump to row
        <input class="rows-input" type="number" min="0" (change)="jump($event)" />
      </label>

      <label class="check">
        <input type="checkbox" [checked]="data.compressed()" (change)="setCompressed($event)" />
        brotli
      </label>

      <span class="divider"></span>

      <label>
        Search
        <input
          type="search"
          placeholder="title contains…"
          [value]="query()"
          (input)="onQuery($event)"
        />
      </label>

      <label>
        Status
        <select [value]="statusValue()" (change)="setStatus($event)">
          <option value="">any</option>
          @for (status of data.meta()?.statuses ?? []; track status; let i = $index) {
            <option [value]="i">{{ status }}</option>
          }
        </select>
      </label>

      <label>
        Category
        <select [value]="categoryValue()" (change)="setCategory($event)">
          <option value="">any</option>
          @for (category of data.meta()?.categories ?? []; track category; let i = $index) {
            <option [value]="i">{{ category }}</option>
          }
        </select>
      </label>

      <span class="divider"></span>

      <button class="primary" (click)="rerun()" [disabled]="data.loading()">
        {{ data.loading() ? 'loading…' : 'run' }}
      </button>
      <button class="ghost" (click)="data.exportRuns()" [disabled]="!data.runs().length">
        export runs
      </button>

      <span class="hint">{{ hint() }}</span>
    </div>
  `,
  styles: `
    .bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: end;
      padding: 10px 14px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    label.dim {
      opacity: 0.45;
    }
    label.check {
      flex-direction: row;
      align-items: center;
      gap: 6px;
      text-transform: none;
      font-size: 13px;
    }
    select,
    input {
      background: var(--panel-2);
      color: var(--fg);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 13px;
      font-family: inherit;
    }
    .rows-input {
      width: 110px;
    }
    button {
      border-radius: 6px;
      padding: 7px 14px;
      font-size: 13px;
      border: 1px solid var(--line);
      cursor: pointer;
      font-family: inherit;
    }
    button.primary {
      background: var(--accent);
      color: #08131f;
      border-color: transparent;
      font-weight: 600;
    }
    button.ghost {
      background: var(--panel-2);
      color: var(--fg);
    }
    button[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    .divider {
      width: 1px;
      align-self: stretch;
      background: var(--line);
    }
    .hint {
      font-size: 12px;
      color: var(--muted);
      max-width: 320px;
    }
  `,
})
export class ToolbarComponent {
  readonly data = inject(DataService);
  readonly modes = MODES;
  readonly imageModes = IMAGE_MODES;
  readonly query = signal('');

  readonly hint = computed(
    () => MODES.find((mode) => mode.value === this.data.mode())?.hint ?? '',
  );
  readonly clientSide = computed(() => this.data.mode() !== 'paged');
  readonly clientCap = computed(() => Math.min(this.data.meta()?.rows ?? 0, MAX_CLIENT_ROWS));
  readonly clientCapM = computed(() => Math.round((this.clientCap() / 1_000_000) * 10) / 10);
  readonly statusValue = computed(() => {
    const status = this.data.filters().status;
    return status === null ? '' : String(status);
  });
  readonly categoryValue = computed(() => {
    const category = this.data.filters().category;
    return category === null ? '' : String(category);
  });

  private debounce: ReturnType<typeof setTimeout> | null = null;

  setMode(event: Event): void {
    this.data.mode.set((event.target as HTMLSelectElement).value as Mode);
    void this.data.run();
  }

  setImageMode(event: Event): void {
    this.data.imageMode.set((event.target as HTMLSelectElement).value as ImageMode);
  }

  setLimit(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) return;
    // Clamped rather than obeyed: past the ceiling the tab dies instead of
    // producing a measurement.
    const clamped = Math.min(Math.floor(value), this.clientCap());
    this.data.limit.set(clamped);
    if (clamped !== Math.floor(value)) input.value = String(clamped);
  }

  jump(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.data.jump(Math.floor(value));
  }

  setCompressed(event: Event): void {
    this.data.compressed.set((event.target as HTMLInputElement).checked);
  }

  loadEverything(): void {
    this.data.limit.set(this.data.meta()?.rows ?? 0);
    void this.data.run();
  }

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    // Filtering 250k rows on every keystroke would be self-inflicted jank.
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.pushFilters(), 250);
  }

  setStatus(event: Event): void {
    const raw = (event.target as HTMLSelectElement).value;
    this.data.filters.update((filters) => ({
      ...filters,
      status: raw === '' ? null : Number(raw),
    }));
    this.pushFilters();
  }

  setCategory(event: Event): void {
    const raw = (event.target as HTMLSelectElement).value;
    this.data.filters.update((filters) => ({
      ...filters,
      category: raw === '' ? null : Number(raw),
    }));
    this.pushFilters();
  }

  rerun(): void {
    void this.data.run();
  }

  private pushFilters(): void {
    void this.data.applyFilters({ ...this.data.filters(), q: this.query() });
  }
}
