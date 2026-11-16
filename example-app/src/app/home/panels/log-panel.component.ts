import { Component, computed, inject, signal } from '@angular/core';

import { buildTestRecord } from '../../harness/automation';
import { CameraHarnessService } from '../../harness/camera-harness.service';
import { formatLogEntry } from '../../harness/event-log';
import { HarnessUiService } from '../../harness/harness-ui.service';

/** The event log, newest first, with copy and export. Image payloads never appear in it. */
@Component({
  selector: 'app-log-panel',
  template: `
    <section class="cph-section">
      <h2 class="cph-h">
        Event log <span class="cph-tag">{{ lines().length }} entries, newest first</span>
      </h2>
      <div class="cph-actions cph-actions-start">
        <button type="button" class="cph-btn" data-testid="log-copy" (click)="copyLog()">Copy log</button>
        <button type="button" class="cph-btn" data-testid="log-export" (click)="exportRecord()">
          Export test record
        </button>
        <button type="button" class="cph-btn" (click)="harness.clearLog()">Clear</button>
      </div>
      @if (status(); as text) {
        <p class="cph-hint" aria-live="polite">{{ text }}</p>
      }
      @if (exported(); as json) {
        <textarea class="cph-export" readonly aria-label="Exported test record" data-testid="log-export-text">{{
          json
        }}</textarea>
      }
      <ol class="cph-log" data-testid="log-list">
        @for (line of lines(); track line.seq) {
          <li class="cph-log-line" [attr.data-kind]="line.kind">{{ line.text }}</li>
        } @empty {
          <li class="cph-log-line">Nothing logged yet.</li>
        }
      </ol>
    </section>
  `,
})
export class LogPanelComponent {
  protected readonly harness = inject(CameraHarnessService);
  private readonly ui = inject(HarnessUiService);

  protected readonly status = signal<string | null>(null);
  protected readonly exported = signal<string | null>(null);

  protected readonly lines = computed(() =>
    this.harness
      .log()
      .map((entry) => ({ seq: entry.seq, kind: entry.kind, text: formatLogEntry(entry) }))
      .reverse(),
  );

  protected async copyLog(): Promise<void> {
    const text = this.harness
      .log()
      .map((entry) => formatLogEntry(entry))
      .join('\n');
    await this.copy(text, 'Log copied to the clipboard.');
  }

  /** Shows the record as selectable text as well, because the clipboard is not always available. */
  protected async exportRecord(): Promise<void> {
    const json = JSON.stringify(buildTestRecord(this.harness, this.ui), null, 2);
    this.exported.set(json);
    await this.copy(json, 'Test record copied to the clipboard and shown below.');
  }

  private async copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.status.set(done);
    } catch {
      this.status.set('The clipboard is not available here; select the text instead.');
    }
  }
}
