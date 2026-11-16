import { Component, computed, inject } from '@angular/core';

import { CameraHarnessService } from '../../harness/camera-harness.service';
import { HarnessUiService } from '../../harness/harness-ui.service';
import { LAB_SCENARIOS } from '../../harness/scenarios';
import type { LabScenario } from '../../harness/scenarios';

/**
 * Concurrency lab. Unlike the normal controls, these buttons issue overlapping calls on purpose and
 * show how each one settled; a call that never settles is the failure they exist to expose.
 */
@Component({
  selector: 'app-lab-panel',
  template: `
    <section class="cph-section">
      <h2 class="cph-h">Concurrency lab</h2>
      <p class="cph-hint">
        Each scenario issues the calls named on its button in the same tick, using
        <code>{{ startJson() }}</code> when it needs a preview. Every call must settle exactly once.
      </p>
      <div class="cph-lab-list">
        @for (scenario of scenarios; track scenario.id) {
          <button
            type="button"
            class="cph-lab-btn"
            [attr.data-testid]="'lab-' + scenario.id"
            [disabled]="ui.labRunning() !== null"
            (click)="run(scenario)"
          >
            <strong>{{ scenario.label }}</strong>
            <span>{{ scenario.issues }}</span>
          </button>
        }
      </div>
    </section>

    @if (ui.labRunning(); as running) {
      <section class="cph-section">
        <p class="cph-hint" aria-live="polite">Running "{{ running }}"…</p>
      </section>
    }

    @if (ui.labResult(); as result) {
      <section class="cph-section" data-testid="lab-result">
        <h2 class="cph-h">
          {{ result.label }}
          <span class="cph-tag" [class.cph-tag-bad]="result.unsettled > 0">
            {{ result.unsettled === 0 ? 'every call settled' : result.unsettled + ' unsettled' }}
          </span>
        </h2>
        @for (group of result.groups; track group.name) {
          <table class="cph-table">
            <caption>{{ group.name }}</caption>
            <thead>
              <tr>
                <th scope="col">Call</th>
                <th scope="col">Outcome</th>
                <th scope="col">ms</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              @for (call of group.calls; track call.label) {
                <tr [attr.data-outcome]="call.outcome">
                  <td>{{ call.label }}</td>
                  <td>{{ call.outcome }}</td>
                  <td>{{ call.durationMs }}</td>
                  <td>
                    {{ call.error ?? (call.resultKeys?.length ? '{ ' + call.resultKeys?.join(', ') + ' }' : '') }}
                    @if (call.expectedUnsupported) {
                      <em>(unsupported here — expected)</em>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
        @if (checksJson(); as checks) {
          <pre class="cph-json">{{ checks }}</pre>
        }
      </section>
    }
  `,
})
export class LabPanelComponent {
  protected readonly harness = inject(CameraHarnessService);
  protected readonly ui = inject(HarnessUiService);

  protected readonly scenarios = LAB_SCENARIOS;
  protected readonly startJson = computed(() => JSON.stringify(this.ui.labStartOptions()));
  protected readonly checksJson = computed(() => {
    const checks = this.ui.labResult()?.checks;
    return checks && Object.keys(checks).length > 0 ? JSON.stringify(checks, null, 2) : null;
  });

  protected run(scenario: LabScenario): void {
    void this.ui.runLab(scenario);
  }
}
