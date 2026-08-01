import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { patchRow } from '../core/api';
import { DataService } from '../core/data.service';
import { RowVm } from '../core/types';

const ROW_H = 44;
const OVERSCAN = 12;

/**
 * Browsers cap the pixel height of an element (Chrome/Firefox around 33.5M px,
 * Safari around 17.9M). At 44 px per row a naive spacer breaks past ~400k rows in
 * Safari, so the spacer is capped and scroll position is scaled into row space.
 *
 * The cost is scroll resolution: 20M rows is 880M px of content mapped onto 16M px
 * of scrollbar, so one pixel of drag covers ~55 rows and fine scrolling near a
 * target is impossible. That is why the toolbar has a jump-to-row box — past a few
 * hundred thousand rows a scrollbar stops being a usable way to reach a position.
 */
const MAX_SPACER_PX = 16_000_000;
/** Images are only fetched once scrolling settles; a fling would otherwise queue
 *  dozens of requests for rows nobody will see. */
const SCROLL_IDLE_MS = 120;

@Component({
  selector: 'app-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid">
      <div class="head" [style.width.px]="totalWidth()">
        @for (column of columns(); track column.key) {
          <div
            class="cell head-cell"
            [style.width.px]="column.width"
            [class.sortable]="column.key !== 'image_id'"
            [class.sorted]="sortKey() === column.key"
            (click)="sortBy(column.key)"
          >
            {{ column.label }}
            @if (sortKey() === column.key) {
              <span class="arrow">{{ sortDesc() ? '▼' : '▲' }}</span>
            }
          </div>
        }
      </div>

      <div class="viewport" #viewport (scroll)="onScroll()">
        <div class="spacer" [style.height.px]="spacerPx()"></div>
        <div class="rows" [style.transform]="'translateY(' + renderTop() + 'px)'">
          @for (row of rows(); track row.id) {
            <div class="row" [style.width.px]="totalWidth()" [class.inactive]="!row.active">
              <div class="cell thumb-cell" [style.width.px]="56">
                <span class="thumb" [style.background-color]="color(row)">
                  @if (imageMode() === 'atlas') {
                    <span
                      class="sprite"
                      [style.background-size]="spriteSize()"
                      [style.background-position]="spritePosition(row)"
                    ></span>
                  } @else if (showImages()) {
                    <img
                      class="pixels"
                      [src]="thumbSrc(row)"
                      width="32"
                      height="32"
                      decoding="async"
                      fetchpriority="low"
                      alt=""
                    />
                  }
                </span>
              </div>
              <div class="cell num" [style.width.px]="90">{{ row.id }}</div>
              <div class="cell" [style.width.px]="260" [title]="row.title">{{ row.title }}</div>
              <div class="cell" [style.width.px]="140">{{ row.category }}</div>
              <div class="cell" [style.width.px]="120">
                <span class="badge" [attr.data-status]="row.status">{{ row.status }}</span>
              </div>
              <div class="cell num editable" [style.width.px]="110" (dblclick)="edit(row, 'price')">
                @if (isEditing(row, 'price')) {
                  <input
                    class="editor"
                    type="number"
                    step="0.01"
                    [value]="row.price"
                    (keydown.enter)="commit($event, row, 'price')"
                    (blur)="commit($event, row, 'price')"
                    autofocus
                  />
                } @else {
                  {{ money(row.price) }}
                }
              </div>
              <div class="cell num editable" [style.width.px]="90" (dblclick)="edit(row, 'qty')">
                @if (isEditing(row, 'qty')) {
                  <input
                    class="editor"
                    type="number"
                    [value]="row.qty"
                    (keydown.enter)="commit($event, row, 'qty')"
                    (blur)="commit($event, row, 'qty')"
                    autofocus
                  />
                } @else {
                  {{ row.qty }}
                }
              </div>
              <div class="cell" [style.width.px]="160">{{ date(row.createdAt) }}</div>
              <div class="cell" [style.width.px]="90">
                <input
                  type="checkbox"
                  [checked]="row.active"
                  (change)="toggleActive(row, $event)"
                />
              </div>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
      height: 100%;
    }
    .grid {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .head {
      display: flex;
      position: sticky;
      top: 0;
      background: var(--panel-2);
      border-bottom: 1px solid var(--line);
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .head-cell.sortable {
      cursor: pointer;
      user-select: none;
    }
    .head-cell.sorted {
      color: var(--accent);
    }
    .arrow {
      margin-left: 4px;
      font-size: 10px;
    }
    .viewport {
      position: relative;
      flex: 1;
      overflow: auto;
      contain: strict;
    }
    .spacer {
      width: 1px;
    }
    .rows {
      position: absolute;
      top: 0;
      left: 0;
      will-change: transform;
    }
    .row {
      display: flex;
      height: 44px;
      align-items: center;
      border-bottom: 1px solid var(--line-soft);
      /* Skip layout and paint for rows scrolled out of the container. */
      content-visibility: auto;
      contain-intrinsic-size: auto 44px;
    }
    .row.inactive {
      opacity: 0.55;
    }
    .cell {
      padding: 0 10px;
      flex: 0 0 auto;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 13px;
    }
    .cell.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .editable {
      cursor: text;
    }
    .editor {
      width: 100%;
      background: var(--panel-2);
      border: 1px solid var(--accent);
      color: inherit;
      font: inherit;
      text-align: right;
      border-radius: 4px;
    }
    .thumb-cell {
      display: flex;
      align-items: center;
    }
    .thumb {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      overflow: hidden;
      display: block;
      flex: 0 0 auto;
    }
    .pixels,
    .sprite {
      display: block;
      width: 32px;
      height: 32px;
    }
    .sprite {
      background-image: url('/api/atlas.png');
      background-repeat: no-repeat;
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--chip);
    }
    .badge[data-status='published'] {
      background: #1f6f43;
    }
    .badge[data-status='flagged'] {
      background: #7a2f2f;
    }
    .badge[data-status='archived'] {
      background: #3a3a44;
    }
  `,
})
export class TableComponent {
  private readonly data = inject(DataService);
  private readonly viewport = viewChild.required<ElementRef<HTMLDivElement>>('viewport');

  readonly rows = this.data.rows;
  readonly imageMode = this.data.imageMode;
  readonly columns = computed(() => this.data.meta()?.columns ?? []);
  readonly totalWidth = computed(() =>
    this.columns().reduce((sum, column) => sum + column.width, 0),
  );
  readonly sortKey = computed(() => this.data.sort()?.key ?? '');
  readonly sortDesc = computed(() => this.data.sort()?.desc ?? false);

  readonly scrollTop = signal(0);
  readonly scrolling = signal(false);
  readonly renderTop = computed(() => this.scrollTop());
  readonly totalPx = computed(() => this.data.virtualRows() * ROW_H);
  readonly spacerPx = computed(() => Math.min(this.totalPx(), MAX_SPACER_PX));
  /** Rows per pixel of scrollbar once the spacer is capped. */
  readonly scale = computed(() => this.totalPx() / Math.max(1, this.spacerPx()));
  readonly showImages = computed(() => this.imageMode() !== 'none' && !this.scrolling());

  readonly spriteSize = computed(() => {
    const atlas = this.data.meta()?.atlas;
    if (!atlas) return 'auto';
    // Atlas cells are 64px, displayed at 32px, so the whole sheet is halved.
    return `${atlas.width / 2}px ${atlas.height / 2}px`;
  });

  private editing = signal<{ id: number; field: string } | null>(null);
  private frame = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFirst = -1;

  constructor() {
    // Any change of dataset size or ordering invalidates the current window.
    effect(() => {
      this.data.virtualRows();
      this.lastFirst = -1;
      const element = this.viewport().nativeElement;
      if (element.scrollTop !== 0 && this.data.windowOffset() === 0) {
        element.scrollTop = 0;
        this.scrollTop.set(0);
      }
    });

    effect(() => {
      const target = this.data.jumpTo();
      if (!target) return;
      const element = this.viewport().nativeElement;
      element.scrollTop = (target.row * ROW_H) / this.scale();
      this.scrollTop.set(element.scrollTop);
      this.lastFirst = -1;
      this.syncWindow();
    });
  }

  onScroll(): void {
    const element = this.viewport().nativeElement;
    this.scrollTop.set(element.scrollTop);
    this.scrolling.set(true);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.scrolling.set(false), SCROLL_IDLE_MS);
    // Coalesce to one window request per frame; scroll fires far more often.
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.syncWindow();
    });
  }

  private syncWindow(): void {
    const element = this.viewport().nativeElement;
    const first = Math.max(0, Math.floor((element.scrollTop * this.scale()) / ROW_H));
    const visible = Math.ceil(element.clientHeight / ROW_H) + OVERSCAN;
    if (first === this.lastFirst) return;
    this.lastFirst = first;
    void this.data.requestWindow(first, visible);
  }

  sortBy(key: string): void {
    if (key === 'image_id') return;
    void this.data.applySort(key);
  }

  color(row: RowVm): string {
    return this.data.meta()?.atlas.colors[row.imageId % (this.data.meta()?.atlas.count ?? 1)] ?? '#333';
  }

  thumbSrc(row: RowVm): string {
    if (row.thumb) return row.thumb;
    return this.imageMode() === 'unique'
      ? `/api/thumb/row/${row.id}`
      : `/api/thumb/${row.imageId}`;
  }

  spritePosition(row: RowVm): string {
    const atlas = this.data.meta()?.atlas;
    if (!atlas) return '0 0';
    const index = row.imageId % atlas.count;
    const half = atlas.cell / 2;
    return `-${(index % atlas.cols) * half}px -${Math.floor(index / atlas.cols) * half}px`;
  }

  money(value: number): string {
    return value.toFixed(2);
  }

  date(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  isEditing(row: RowVm, field: string): boolean {
    const editing = this.editing();
    return editing?.id === row.id && editing.field === field;
  }

  edit(row: RowVm, field: string): void {
    this.editing.set({ id: row.id, field });
  }

  async commit(event: Event, row: RowVm, field: 'price' | 'qty'): Promise<void> {
    const input = event.target as HTMLInputElement;
    const value = field === 'price' ? Number(input.value) : Math.round(Number(input.value));
    this.editing.set(null);
    if (!Number.isFinite(value) || value === row[field]) return;
    await patchRow(row.id, { [field]: value });
    await this.refresh();
  }

  async toggleActive(row: RowVm, event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    await patchRow(row.id, { active: checked });
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    // Edits invalidate the server's cached permutation, so re-pull the window.
    await this.data.requestWindow(this.data.windowOffset(), this.rows().length || 60);
  }
}
