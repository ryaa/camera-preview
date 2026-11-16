import { Component, computed, inject } from '@angular/core';

import { CameraHarnessService } from '../../harness/camera-harness.service';
import { COVERAGE_ITEMS, supportSymbol } from '../../harness/capabilities';
import type { CoverageItem, CoverageKind, HarnessPlatform } from '../../harness/capabilities';

interface CoverageRow {
  item: CoverageItem;
  exercised: boolean;
  cells: { platform: HarnessPlatform; symbol: string; note: string; current: boolean }[];
}

const GROUPS: readonly { kind: CoverageKind; title: string }[] = [
  { kind: 'method', title: 'Methods' },
  { kind: 'start-option', title: 'start() options' },
  { kind: 'call-option', title: 'Options of other calls' },
];
const PLATFORMS: readonly HarnessPlatform[] = ['android', 'ios', 'web'];

/**
 * Every public method and option, what each platform does with it today, and whether this run has
 * exercised it. A tick means the method was called, or the option key was sent, at least once.
 */
@Component({
  selector: 'app-coverage-panel',
  template: `
    <section class="cph-section">
      <h2 class="cph-h">
        Coverage
        <span class="cph-tag" data-testid="coverage-count">{{ exercisedCount() }} of {{ total }} exercised</span>
      </h2>
      <p class="cph-hint">
        ✓ supported · ◐ accepted but ignored or partial · ✗ unsupported. The column for
        {{ harness.platform }} is highlighted. A tick in the first column means this run called the method or sent
        the option. It does not mean that the effect of the option was verified.
      </p>
    </section>

    @for (group of groups(); track group.title) {
      <section class="cph-section">
        <table class="cph-table cph-coverage">
          <caption>{{ group.title }}</caption>
          <thead>
            <tr>
              <th scope="col"><span class="cph-sr">Exercised</span></th>
              <th scope="col">Item</th>
              <th scope="col">Android</th>
              <th scope="col">iOS</th>
              <th scope="col">Web</th>
            </tr>
          </thead>
          <tbody>
            @for (row of group.rows; track row.item.id) {
              <tr [class.cph-done]="row.exercised" [attr.data-coverage-id]="row.item.id">
                <td>{{ row.exercised ? '☑' : '☐' }}</td>
                <td>
                  <strong>{{ row.item.label }}</strong>
                  @if (row.item.undeclared) {
                    <em> (not in the typings)</em>
                  }
                  <span class="cph-cov-how">{{ row.item.exercisedBy }}</span>
                </td>
                @for (cell of row.cells; track cell.platform) {
                  <td [class.cph-current]="cell.current">
                    {{ cell.symbol }}
                    @if (cell.note) {
                      <span class="cph-cov-note">{{ cell.note }}</span>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </section>
    }
  `,
})
export class CoveragePanelComponent {
  protected readonly harness = inject(CameraHarnessService);

  protected readonly total = COVERAGE_ITEMS.length;
  protected readonly exercisedCount = computed(
    () => COVERAGE_ITEMS.filter((item) => this.harness.exercised().has(item.id)).length,
  );

  protected readonly groups = computed(() => {
    const exercised = this.harness.exercised();
    return GROUPS.map((group) => ({
      title: group.title,
      rows: COVERAGE_ITEMS.filter((item) => item.kind === group.kind).map(
        (item): CoverageRow => ({
          item,
          exercised: exercised.has(item.id),
          cells: PLATFORMS.map((platform) => ({
            platform,
            symbol: supportSymbol(item.support[platform].level),
            note: item.support[platform].note ?? '',
            current: platform === this.harness.platform,
          })),
        }),
      ),
    }));
  });
}
