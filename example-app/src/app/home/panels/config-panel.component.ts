import { Component, computed, inject } from '@angular/core';

import { CameraHarnessService } from '../../harness/camera-harness.service';
import { AUTO_STOP_SECONDS, HarnessUiService } from '../../harness/harness-ui.service';
import { BOOLEAN_START_KEYS, NUMBER_START_KEYS } from '../../harness/option-model';
import type {
  BooleanStartKey,
  NumberField,
  NumberStartKey,
  StartOptionsForm,
  TextStartKey,
  TriBool,
} from '../../harness/option-model';
import { PRESETS } from '../../harness/presets';
import type { Preset } from '../../harness/presets';
import { NumberFieldComponent, SupportBadgeComponent, TriToggleComponent } from '../controls/controls';

type PositionChoice = 'unset' | 'rear' | 'front' | 'custom';

/** Everything passed to `start()`. Nothing here takes effect until Start or Restart is pressed. */
@Component({
  selector: 'app-config-panel',
  templateUrl: 'config-panel.component.html',
  imports: [NumberFieldComponent, SupportBadgeComponent, TriToggleComponent],
})
export class ConfigPanelComponent {
  protected readonly harness = inject(CameraHarnessService);
  protected readonly ui = inject(HarnessUiService);

  protected readonly presets = PRESETS;
  protected readonly numberKeys = NUMBER_START_KEYS;
  protected readonly booleanKeys = BOOLEAN_START_KEYS;
  protected readonly positionChoices: readonly PositionChoice[] = ['unset', 'rear', 'front', 'custom'];
  protected readonly autoStopSeconds = AUTO_STOP_SECONDS;

  protected readonly optionsJson = computed(() => JSON.stringify(this.ui.startOptions(), null, 2));

  protected readonly positionChoice = computed<PositionChoice>(() => {
    const position = this.ui.startForm().texts.position;
    if (!position.send) {
      return 'unset';
    }
    return position.value === 'rear' || position.value === 'front' ? position.value : 'custom';
  });

  protected readonly rectSummary = computed(() => {
    const rect = this.ui.formRect();
    if (!rect || rect.height <= 0) {
      return null;
    }
    const round = (value: number): number => Math.round(value * 10) / 10;
    return `${round(rect.width)} × ${round(rect.height)} CSS px at (${round(rect.x)}, ${round(rect.y)}) — aspect ${(
      rect.width / rect.height
    ).toFixed(3)}`;
  });

  protected usePreset(preset: Preset): void {
    this.ui.usePreset(preset);
  }

  protected setBoolean(key: BooleanStartKey, value: TriBool): void {
    this.patch((form) => ({ ...form, booleans: { ...form.booleans, [key]: value } }));
  }

  protected setNumber(key: NumberStartKey, field: NumberField): void {
    this.patch((form) => ({ ...form, numbers: { ...form.numbers, [key]: field } }));
  }

  protected setPosition(choice: PositionChoice): void {
    const current = this.ui.startForm().texts.position.value;
    if (choice === 'unset') {
      this.setText('position', false, current);
    } else if (choice === 'custom') {
      this.setText('position', true, current === 'rear' || current === 'front' ? 'back' : current);
    } else {
      this.setText('position', true, choice);
    }
  }

  protected setTextSend(key: TextStartKey, event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.setText(key, event.target.checked, this.ui.startForm().texts[key].value);
    }
  }

  protected setTextValue(key: TextStartKey, event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.setText(key, true, event.target.value);
    }
  }

  protected async start(): Promise<void> {
    await this.ui.startFromForm();
  }

  private setText(key: TextStartKey, send: boolean, value: string): void {
    this.patch((form) => ({ ...form, texts: { ...form.texts, [key]: { send, value } } }));
  }

  private patch(change: (form: StartOptionsForm) => StartOptionsForm): void {
    this.ui.startForm.set(change(this.ui.startForm()));
    this.ui.lastPreset.set(null);
  }
}
