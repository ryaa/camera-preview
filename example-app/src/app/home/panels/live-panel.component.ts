import { Component, computed, inject, signal } from '@angular/core';

import { CameraHarnessService } from '../../harness/camera-harness.service';
import { HarnessUiService } from '../../harness/harness-ui.service';
import type { CaptureForm, NumberField, RecordForm, TriBool } from '../../harness/option-model';
import { NumberFieldComponent, SupportBadgeComponent, TriToggleComponent } from '../controls/controls';

/** A value no platform supports, to show how an unknown flash mode is rejected. */
const UNSUPPORTED_FLASH_MODE = 'strobe';
const ALL_FLASH_MODES: readonly string[] = ['off', 'on', 'auto', 'red-eye', 'torch'];

/** Actions on a running preview. Their arguments apply to the next call, not at start(). */
@Component({
  selector: 'app-live-panel',
  templateUrl: 'live-panel.component.html',
  imports: [NumberFieldComponent, SupportBadgeComponent, TriToggleComponent],
})
export class LivePanelComponent {
  protected readonly harness = inject(CameraHarnessService);
  protected readonly ui = inject(HarnessUiService);

  protected readonly unsupportedFlashMode = UNSUPPORTED_FLASH_MODE;
  protected readonly samplingInterval = signal<NumberField>({ send: true, value: 500 });

  protected readonly captureJson = computed(() => JSON.stringify(this.ui.captureOptions()));
  protected readonly sampleJson = computed(() => JSON.stringify(this.ui.sampleOptions()));
  protected readonly opacityJson = computed(() => JSON.stringify(this.ui.opacityOptions()));
  protected readonly recordJson = computed(() => JSON.stringify(this.ui.recordOptions()));

  /** Modes the camera reported; before a query, every declared mode is offered. */
  protected readonly flashChoices = computed(() => this.harness.flashModes() ?? ALL_FLASH_MODES);

  protected setCaptureField(key: keyof CaptureForm, field: NumberField): void {
    const form = { ...this.ui.captureForm() };
    form[key] = field;
    this.ui.captureForm.set(form);
  }

  protected setSampleQuality(field: NumberField): void {
    this.ui.sampleForm.set({ quality: field });
  }

  protected setOpacityField(field: NumberField): void {
    this.ui.opacityForm.set({ opacity: field });
  }

  protected setOpacityFromRange(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.ui.opacityForm.set({ opacity: { send: true, value: Number(event.target.value) } });
    }
  }

  protected setRecordNumber(key: 'width' | 'height' | 'maxDuration', field: NumberField): void {
    const form = { ...this.ui.recordForm() };
    form[key] = field;
    this.ui.recordForm.set(form);
  }

  protected setRecordFlash(value: TriBool): void {
    this.patchRecord({ withFlash: value });
  }

  protected setRecordPositionSend(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.patchRecord({ position: { send: event.target.checked, value: this.ui.recordForm().position.value } });
    }
  }

  protected setRecordPositionValue(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.patchRecord({ position: { send: true, value: event.target.value } });
    }
  }

  protected async capture(): Promise<void> {
    const { record } = await this.harness.capture(this.ui.captureOptions());
    if (record.outcome === 'resolved') {
      this.ui.panel.set('results');
    }
  }

  protected async sample(): Promise<void> {
    const { record } = await this.harness.captureSample(this.ui.sampleOptions());
    if (record.outcome === 'resolved') {
      this.ui.panel.set('results');
    }
  }

  protected toggleSampling(): void {
    if (this.harness.sampling()) {
      this.harness.stopSampling();
    } else {
      this.harness.startSampling(this.samplingInterval().value ?? 500, this.ui.sampleOptions());
    }
  }

  protected queryFlash(): void {
    void this.harness.getSupportedFlashModes();
  }

  protected setFlash(flashMode: string): void {
    void this.harness.setFlashMode({ flashMode });
  }

  protected applyOpacity(): void {
    void this.harness.setOpacity(this.ui.opacityOptions());
  }

  protected startRecording(): void {
    void this.harness.startRecordVideo(this.ui.recordOptions());
  }

  protected async stopRecording(): Promise<void> {
    const { record } = await this.harness.stopRecordVideo();
    if (record.video) {
      this.ui.panel.set('results');
    }
  }

  protected checkReady(): void {
    void this.harness.isCameraStarted();
  }

  protected requestMicrophone(): void {
    void this.harness.requestMicrophone();
  }

  private patchRecord(change: Partial<RecordForm>): void {
    this.ui.recordForm.set({ ...this.ui.recordForm(), ...change });
  }
}
