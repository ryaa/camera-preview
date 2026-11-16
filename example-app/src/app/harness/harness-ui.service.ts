import { Injectable, computed, inject, signal } from '@angular/core';
import type { CameraPreviewOptions } from '@capacitor-community/camera-preview';

import { CameraHarnessService } from './camera-harness.service';
import type { CallResult } from './camera-harness.service';
import {
  buildCaptureOptions,
  buildOpacityOptions,
  buildRecordOptions,
  buildSampleOptions,
  buildStartOptions,
  emptyCaptureForm,
  emptyOpacityForm,
  emptyRecordForm,
  emptySampleForm,
  startFormFromOptions,
} from './option-model';
import type { CaptureForm, OpacityForm, RecordForm, SampleForm, StartOptionsForm } from './option-model';
import { applyPreset, controlBand, requestedRect } from './presets';
import type { ControlBand, CssRect, Preset, ViewportMetrics } from './presets';
import { defaultStartOptions, runScenario } from './scenarios';
import type { LabResult, LabScenario } from './scenarios';

export type PanelId = 'configure' | 'live' | 'results' | 'log' | 'lab' | 'coverage';

export const PANELS: readonly { id: PanelId; label: string }[] = [
  { id: 'configure', label: 'Configure' },
  { id: 'live', label: 'Live' },
  { id: 'results', label: 'Results' },
  { id: 'log', label: 'Log' },
  { id: 'lab', label: 'Lab' },
  { id: 'coverage', label: 'Coverage' },
];

/** Seconds before a preview that leaves no room for the controls is stopped automatically. */
export const AUTO_STOP_SECONDS = 15;

/**
 * View state shared by the shell and the panels: the argument forms, the selected panel, and the
 * measured viewport. It holds no plugin state; that lives in {@link CameraHarnessService}.
 */
@Injectable({ providedIn: 'root' })
export class HarnessUiService {
  private readonly harness = inject(CameraHarnessService);

  public readonly panel = signal<PanelId>('configure');
  /** Collapses the controls to a chip so the whole preview can be judged. */
  public readonly peek = signal(false);
  /** Hides every harness element; used by automation before a host-side screenshot. */
  public readonly chromeHidden = signal(false);
  /**
   * Opaque colour painted over the whole page, or `null`. Automation uses it so that a preview in
   * front of the page (`toBack: false`) can be measured in a host screenshot: everything that is not
   * this colour is the native view.
   */
  public readonly backdrop = signal<string | null>(null);
  public readonly showGuide = signal(true);
  /**
   * Whether a preview that hides the controls is stopped automatically. An automated driver turns
   * this off: it needs no controls, and a countdown must not end a preview in the middle of a run.
   */
  public readonly autoStopAllowed = signal(true);

  public readonly startForm = signal<StartOptionsForm>(this.initialStartForm());
  public readonly captureForm = signal<CaptureForm>(emptyCaptureForm());
  public readonly sampleForm = signal<SampleForm>(emptySampleForm());
  public readonly opacityForm = signal<OpacityForm>(emptyOpacityForm());
  public readonly recordForm = signal<RecordForm>(emptyRecordForm());
  public readonly lastPreset = signal<Preset | null>(null);

  public readonly labResult = signal<LabResult | null>(null);
  public readonly labRunning = signal<string | null>(null);

  public readonly viewport = signal({ width: window.innerWidth, height: window.innerHeight });
  public readonly safeTop = signal(0);
  public readonly dockHeight = signal(0);

  public readonly startOptions = computed(() => buildStartOptions(this.startForm()));
  public readonly captureOptions = computed(() => buildCaptureOptions(this.captureForm()));
  public readonly sampleOptions = computed(() => buildSampleOptions(this.sampleForm()));
  public readonly opacityOptions = computed(() => buildOpacityOptions(this.opacityForm()));
  public readonly recordOptions = computed(() => buildRecordOptions(this.recordForm()));

  public readonly metrics = computed<ViewportMetrics>(() => ({
    width: this.viewport().width,
    height: this.viewport().height,
    safeTop: this.safeTop(),
    dockHeight: this.dockHeight(),
    devicePixelRatio: window.devicePixelRatio,
    platform: this.harness.platform,
  }));

  /** Rectangle the form would request if Start were pressed now. */
  public readonly formRect = computed<CssRect | null>(() => requestedRect(this.startOptions(), this.metrics()));

  /** True when the configured preview would hide the page and leave no band for the controls. */
  public readonly formCoversControls = computed(() =>
    this.coversControls(this.startOptions(), this.formRect(), this.metrics()),
  );

  /**
   * Where the shell must sit while a `toBack: false` preview is running. `null` means the whole
   * viewport: either the preview is behind the page, or nothing is running.
   */
  public readonly shellBand = computed<ControlBand | null>(() => {
    const options = this.harness.sessionOptions();
    const rect = this.harness.previewRect();
    if (!options || !rect || options.toBack === true) {
      return null;
    }
    return controlBand(rect, this.metrics());
  });

  constructor() {
    this.harness.setMetricsProvider(() => this.metrics());
  }

  public usePreset(preset: Preset): void {
    this.startForm.set(applyPreset(this.startForm(), preset, this.metrics()));
    this.lastPreset.set(preset);
  }

  public resetStartForm(): void {
    this.startForm.set(this.initialStartForm());
    this.lastPreset.set(null);
  }

  /** Starts (or restarts) the preview with exactly the options shown in the Configure panel. */
  public async startFromForm(): Promise<CallResult<void>> {
    const options = this.startOptions();
    const covers = this.formCoversControls();

    if (this.harness.sessionActive()) {
      await this.harness.stop();
    }
    const result = await this.harness.start(options);
    if (covers && this.autoStopAllowed() && this.harness.sessionActive()) {
      this.harness.armAutoStop(AUTO_STOP_SECONDS);
    }
    return result;
  }

  /**
   * To be called after every measurement of the viewport. Lets the rectangle of a running preview
   * follow the change (the guide and the band of the shell are derived from it), and then checks
   * again whether the controls can still be reached.
   *
   * The second step does not depend on the first: the room left for the controls is a matter of the
   * rectangle *and* the viewport, and the viewport can change while the rectangle stays as it is —
   * Android keeps a wide rectangle unchanged when the device turns to landscape, for example.
   */
  public viewportChanged(): void {
    this.harness.viewportChanged();
    this.updateControlRecovery();
  }

  public setAutoStopAllowed(allowed: boolean): void {
    this.autoStopAllowed.set(allowed);
    if (!allowed) {
      this.harness.cancelAutoStop();
    } else {
      this.updateControlRecovery();
    }
  }

  /**
   * Arms or cancels the automatic stop according to the current rectangle, viewport and setting:
   * armed while a running preview leaves no band for the controls, cancelled as soon as one is
   * back. A countdown that is already running is left alone, so repeated measurements of the same
   * situation do not restart it.
   */
  private updateControlRecovery(): void {
    const options = this.harness.sessionOptions();
    if (options === null) {
      // Nothing is running; ending the session has already cancelled any countdown.
      return;
    }
    const covers = this.coversControls(options, this.harness.previewRect(), this.metrics());
    const armed = this.harness.autoStopIn() !== null;
    if (covers && !armed && this.autoStopAllowed()) {
      this.harness.note('the preview leaves no band for the controls');
      this.harness.armAutoStop(AUTO_STOP_SECONDS);
    } else if (!covers && armed) {
      // The countdown exists only because the controls could not be reached.
      this.harness.note('the controls are reachable again');
      this.harness.cancelAutoStop();
    }
  }

  public async runLab(scenario: LabScenario, args: Readonly<Record<string, unknown>> = {}): Promise<LabResult> {
    this.labRunning.set(scenario.id);
    this.labResult.set(null);
    try {
      const result = await runScenario(this.harness, scenario, args, this.labStartOptions());
      this.labResult.set(result);
      return result;
    } finally {
      this.labRunning.set(null);
    }
  }

  /**
   * Lab scenarios start a full-screen preview behind the page so the controls stay reachable, but
   * keep the camera and the web parent the user configured.
   */
  public labStartOptions(): CameraPreviewOptions {
    const base = defaultStartOptions(this.harness.platform);
    const position = this.startOptions().position;
    return position === undefined ? base : { ...base, position };
  }

  private coversControls(options: CameraPreviewOptions, rect: CssRect | null, metrics: ViewportMetrics): boolean {
    if (rect === null || options.toBack === true) {
      return false;
    }
    return controlBand(rect, metrics) === null;
  }

  /** The full-screen configuration for this platform: rear camera, behind the page. */
  private initialStartForm(): StartOptionsForm {
    return startFormFromOptions(defaultStartOptions(this.harness.platform));
  }
}
