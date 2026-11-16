import { Component, computed, inject, input, output } from '@angular/core';

import { CameraHarnessService } from '../../harness/camera-harness.service';
import { supportFor, supportSymbol } from '../../harness/capabilities';
import type { NumberField, TriBool } from '../../harness/option-model';

const TRI_VALUES: readonly TriBool[] = ['unset', 'true', 'false'];

/** A boolean option with an explicit "unset" position, so omitting a key is a deliberate choice. */
@Component({
  selector: 'app-tri-toggle',
  template: `
    <div class="cph-tri" role="radiogroup" [attr.aria-label]="label()">
      @for (option of options; track option) {
        <button
          type="button"
          role="radio"
          class="cph-tri-btn"
          [class.cph-on]="value() === option"
          [attr.aria-checked]="value() === option"
          [attr.data-testid]="testId() ? testId() + '-' + option : null"
          (click)="valueChange.emit(option)"
        >
          {{ option }}
        </button>
      }
    </div>
  `,
})
export class TriToggleComponent {
  public readonly value = input.required<TriBool>();
  public readonly label = input('');
  public readonly testId = input('');
  public readonly valueChange = output<TriBool>();

  protected readonly options = TRI_VALUES;
}

/**
 * A numeric option. The checkbox decides whether the key is sent; typing a value ticks it, and
 * unticking keeps the typed value so it can be sent again later.
 */
@Component({
  selector: 'app-number-field',
  template: `
    <label class="cph-num" [class.cph-num-off]="!field().send">
      <input
        type="checkbox"
        class="cph-num-send"
        [checked]="field().send"
        [attr.aria-label]="'Send ' + label()"
        (change)="onToggle($event)"
      />
      <span class="cph-num-label">{{ label() }}</span>
      <input
        type="number"
        class="cph-num-input"
        inputmode="decimal"
        [step]="step()"
        [min]="min()"
        [max]="max()"
        [value]="field().value ?? ''"
        [attr.aria-label]="label()"
        [attr.data-testid]="testId() || null"
        placeholder="unset"
        (input)="onInput($event)"
      />
    </label>
  `,
})
export class NumberFieldComponent {
  public readonly field = input.required<NumberField>();
  public readonly label = input.required<string>();
  public readonly step = input<number | string>(1);
  public readonly min = input<number | null>(null);
  public readonly max = input<number | null>(null);
  public readonly testId = input('');
  public readonly fieldChange = output<NumberField>();

  protected onToggle(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.fieldChange.emit({ send: event.target.checked, value: this.field().value });
    }
  }

  protected onInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    const text = event.target.value.trim();
    const value = text === '' ? null : Number(text);
    if (value !== null && !Number.isFinite(value)) {
      return;
    }
    this.fieldChange.emit({ send: value !== null, value });
  }
}

/**
 * ✓ / ◐ / ✗ for one method or option on the platform the app is running on. With `compact`, an item
 * that is simply supported shows nothing, so a column of options only marks the exceptions.
 */
@Component({
  selector: 'app-support-badge',
  template: `
    @if (visible()) {
      <span class="cph-support" [attr.data-level]="support().level" [attr.title]="support().note || null">
        {{ symbol() }}
      </span>
      @if (showNote() && support().note) {
        <span class="cph-support-note">{{ support().note }}</span>
      }
    }
  `,
})
export class SupportBadgeComponent {
  private readonly harness = inject(CameraHarnessService);

  /** Coverage id: a method name, or `method.option`. */
  public readonly item = input.required<string>();
  public readonly showNote = input(true);
  public readonly compact = input(false);

  protected readonly support = computed(() => supportFor(this.item(), this.harness.platform));
  protected readonly visible = computed(
    () => !this.compact() || this.support().level !== 'supported' || !!this.support().note,
  );
  protected readonly symbol = computed(() => supportSymbol(this.support().level));
}
