import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { DataService } from './core/data.service';
import { HudComponent } from './ui/hud';
import { TableComponent } from './ui/table';
import { ToolbarComponent } from './ui/toolbar';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ToolbarComponent, HudComponent, TableComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly data = inject(DataService);
  protected readonly rowCount = computed(() =>
    (this.data.meta()?.rows ?? 0).toLocaleString('en-US'),
  );

  constructor() {
    void this.data.init();
  }
}
