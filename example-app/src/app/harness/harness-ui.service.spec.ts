import { TestBed, discardPeriodicTasks, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';

import { CAMERA_PREVIEW_PLUGIN, CameraHarnessService, HARNESS_PLATFORM } from './camera-harness.service';
import { AUTO_STOP_SECONDS, HarnessUiService } from './harness-ui.service';
import { FakeCameraPreview } from './testing/fake-camera-preview';

/**
 * Control recovery: a preview in front of the page that leaves no band for the controls is stopped
 * automatically. Whether a band is left depends on the preview rectangle and on the viewport, so it
 * has to be judged again after every measurement of the viewport, not only when the rectangle moved.
 */
describe('HarnessUiService control recovery', () => {
  const WIDE = { position: 'rear', x: 40, y: 120, width: 300, height: 200, toBack: false } as const;

  let plugin: FakeCameraPreview;
  let harness: CameraHarnessService;
  let ui: HarnessUiService;

  /** What the page does after a resize event: store the measured viewport, then tell the service. */
  function measure(width: number, height: number): void {
    ui.viewport.set({ width, height });
    ui.viewportChanged();
  }

  function start(options: Parameters<CameraHarnessService['start']>[0]): void {
    void harness.start(options);
    flushMicrotasks();
    expect(harness.session()).toBe('running');
  }

  beforeEach(() => {
    plugin = new FakeCameraPreview();
    plugin.resolves('start').resolves('stop');
    TestBed.configureTestingModule({
      providers: [
        { provide: CAMERA_PREVIEW_PLUGIN, useValue: plugin },
        { provide: HARNESS_PLATFORM, useValue: 'android' },
      ],
    });
    harness = TestBed.inject(CameraHarnessService);
    ui = TestBed.inject(HarnessUiService);
    harness.setPollingAllowed(false);
    ui.viewport.set({ width: 400, height: 800 });
  });

  afterEach(() => {
    document.documentElement.classList.remove('camera-preview-active');
  });

  it('arms the countdown when the device turns and a wide rectangle stays as it is', fakeAsync(() => {
    start(WIDE);
    expect(ui.shellBand()).toEqual({ top: 320, height: 480 });
    expect(harness.autoStopIn()).toBeNull();

    measure(800, 400);

    // Android leaves a wide rectangle unchanged on the turn to landscape …
    expect(harness.previewRect()).toEqual({ x: 40, y: 120, width: 300, height: 200 });
    // … but 120 px above it and 80 px below are both too little for the controls.
    expect(ui.shellBand()).toBeNull();
    expect(harness.autoStopIn()).toBe(AUTO_STOP_SECONDS);
    expect(harness.log().some((entry) => entry.text === 'the preview leaves no band for the controls')).toBeTrue();

    discardPeriodicTasks();
  }));

  it('arms the countdown when the viewport shrinks without turning', fakeAsync(() => {
    start(WIDE);

    measure(400, 500);

    expect(harness.previewRect()).toEqual({ x: 40, y: 120, width: 300, height: 200 });
    expect(ui.shellBand()).toBeNull();
    expect(harness.autoStopIn()).toBe(AUTO_STOP_SECONDS);

    discardPeriodicTasks();
  }));

  it('cancels the countdown when a usable band is back', fakeAsync(() => {
    start(WIDE);
    measure(400, 500);
    expect(harness.autoStopIn()).toBe(AUTO_STOP_SECONDS);

    measure(400, 800);

    expect(ui.shellBand()).toEqual({ top: 320, height: 480 });
    expect(harness.autoStopIn()).toBeNull();
    expect(harness.session()).toBe('running');
    expect(harness.log().some((entry) => entry.text === 'the controls are reachable again')).toBeTrue();
  }));

  it('does not restart a countdown that is already running', fakeAsync(() => {
    start(WIDE);
    measure(800, 400);
    tick(4000);
    expect(harness.autoStopIn()).toBe(AUTO_STOP_SECONDS - 4);

    // The same situation measured again, and a different one that still leaves no band.
    measure(800, 400);
    measure(780, 400);

    expect(harness.autoStopIn()).toBe(AUTO_STOP_SECONDS - 4);
    expect(harness.log().filter((entry) => /^auto-stop armed/.test(entry.text ?? '')).length).toBe(1);

    discardPeriodicTasks();
  }));

  it('stops the preview when the countdown armed by a measurement runs out', fakeAsync(() => {
    start(WIDE);
    measure(800, 400);

    tick(AUTO_STOP_SECONDS * 1000);
    flushMicrotasks();

    expect(plugin.countOf('stop')).toBe(1);
    expect(harness.session()).toBe('idle');
    expect(harness.autoStopIn()).toBeNull();
  }));

  it('arms nothing for an automated driver that turned the automatic stop off', fakeAsync(() => {
    ui.setAutoStopAllowed(false);
    start(WIDE);

    measure(800, 400);
    measure(400, 500);

    expect(ui.shellBand()).toBeNull();
    expect(harness.autoStopIn()).toBeNull();
    expect(harness.session()).toBe('running');
  }));

  it('arms at once when the automatic stop is allowed again over a preview that hides the controls', fakeAsync(() => {
    ui.setAutoStopAllowed(false);
    start(WIDE);
    measure(800, 400);
    expect(harness.autoStopIn()).toBeNull();

    ui.setAutoStopAllowed(true);
    expect(harness.autoStopIn()).toBe(AUTO_STOP_SECONDS);

    ui.setAutoStopAllowed(false);
    expect(harness.autoStopIn()).toBeNull();
  }));

  it('never arms for a preview behind the page, or with nothing running', fakeAsync(() => {
    measure(800, 400);
    expect(harness.autoStopIn()).toBeNull();

    start({ ...WIDE, toBack: true });
    measure(800, 400);
    measure(400, 300);

    expect(harness.autoStopIn()).toBeNull();
  }));

  it('judges the rectangle after a turn that does change it', fakeAsync(() => {
    // Tall rectangle: exchanged to 280 × 160 at (24, 96) in landscape, which leaves 96 px and 144 px.
    start({ position: 'rear', x: 24, y: 96, width: 160, height: 280, toBack: false });
    expect(ui.shellBand()).toEqual({ top: 376, height: 424 });

    measure(800, 400);

    expect(harness.previewRect()).toEqual({ x: 24, y: 96, width: 280, height: 160 });
    expect(ui.shellBand()).toBeNull();
    expect(harness.autoStopIn()).toBe(AUTO_STOP_SECONDS);

    measure(400, 800);
    expect(harness.autoStopIn()).toBeNull();
  }));
});
