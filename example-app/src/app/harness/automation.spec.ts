import { TestBed } from '@angular/core/testing';

import {
  AUTORUN_DONE,
  AUTORUN_LINE,
  AUTORUN_PART,
  buildTestRecord,
  createAutomationApi,
  encodeAutorunMessage,
  parseAutorunPlan,
  runAutorun,
} from './automation';
import type { HarnessAutomationApi } from './automation';
import { CAMERA_PREVIEW_PLUGIN, CameraHarnessService, HARNESS_PLATFORM } from './camera-harness.service';
import { COVERAGE_ITEMS } from './capabilities';
import { HarnessUiService } from './harness-ui.service';
import { bytesToBase64 } from './image-inspector';
import { LAB_SCENARIOS } from './scenarios';
import { FakeCameraPreview } from './testing/fake-camera-preview';
import { jpegFixture } from './testing/image-fixtures';

const JPEG_BASE64 = bytesToBase64(jpegFixture({ width: 720, height: 1280 }));

describe('automation', () => {
  let plugin: FakeCameraPreview;
  let harness: CameraHarnessService;
  let ui: HarnessUiService;
  let api: HarnessAutomationApi;

  beforeEach(() => {
    plugin = new FakeCameraPreview();
    TestBed.configureTestingModule({
      providers: [
        { provide: CAMERA_PREVIEW_PLUGIN, useValue: plugin },
        { provide: HARNESS_PLATFORM, useValue: 'android' },
      ],
    });
    harness = TestBed.inject(CameraHarnessService);
    ui = TestBed.inject(HarnessUiService);
    harness.setPollingAllowed(false);
    api = createAutomationApi(harness, ui);
  });

  afterEach(() => {
    document.documentElement.classList.remove('camera-preview-active');
  });

  describe('call', () => {
    it('routes every public method to the plugin with the arguments given', async () => {
      plugin
        .resolves('start')
        .resolves('stop')
        .resolves('flip')
        .resolves('isCameraStarted', { value: true })
        .resolves('capture', { value: JPEG_BASE64 })
        .resolves('captureSample', { value: JPEG_BASE64 })
        .resolves('getSupportedFlashModes', { result: ['off'] })
        .resolves('setFlashMode')
        .resolves('setOpacity')
        .resolves('startRecordVideo')
        .resolves('stopRecordVideo', { videoFilePath: '/cache/videoTmp.mp4' });

      await api.call('start', { position: 'front', toBack: true, bogus: 1 });
      await api.call('isCameraStarted');
      await api.call('flip');
      await api.call('capture', { quality: 20, width: 640, height: 480 });
      await api.call('captureSample', { quality: 60 });
      await api.call('getSupportedFlashModes');
      await api.call('setFlashMode', { flashMode: 'torch' });
      await api.call('setOpacity', { opacity: 0.25 });
      await api.call('startRecordVideo', { withFlash: true, maxDuration: 1500 });
      await api.call('stopRecordVideo');
      await api.call('stop');

      expect(plugin.calls).toEqual([
        { method: 'start', args: { position: 'front', toBack: true } },
        { method: 'isCameraStarted', args: undefined },
        { method: 'flip', args: undefined },
        { method: 'capture', args: { quality: 20, width: 640, height: 480 } },
        { method: 'captureSample', args: { quality: 60 } },
        { method: 'getSupportedFlashModes', args: undefined },
        { method: 'setFlashMode', args: { flashMode: 'torch' } },
        { method: 'setOpacity', args: { opacity: 0.25 } },
        { method: 'startRecordVideo', args: { withFlash: true, maxDuration: 1500 } },
        { method: 'stopRecordVideo', args: undefined },
        { method: 'stop', args: undefined },
      ]);
      expect(api.methods().length).toBe(11);
    });

    it('resolves to a JSON-safe record for a rejection instead of rejecting', async () => {
      plugin.rejects('capture', { message: 'Camera is not running' });

      const record = await api.call('capture', { quality: 85 });

      expect(record.outcome).toBe('rejected');
      expect(record.error).toBe('Camera is not running');
      expect(() => JSON.stringify(record)).not.toThrow();
    });

    it('rejects for a method name the plugin does not have', async () => {
      await expectAsync(api.call('takePicture')).toBeRejectedWithError(/unknown method "takePicture"/);
    });

    it('hands back the untouched bytes of an image result', async () => {
      plugin.resolves('capture', { value: JPEG_BASE64 });

      const record = await api.call('capture', { quality: 85 });

      expect(api.imageBase64(record.id)).toBe(JPEG_BASE64);
      expect(api.imageBase64(9999)).toBeNull();
    });
  });

  it('lists the lab scenarios and rejects an unknown one', async () => {
    expect(api.scenarios()).toEqual(LAB_SCENARIOS.map((scenario) => scenario.id));
    await expectAsync(api.runScenario('no-such-scenario')).toBeRejectedWithError(/unknown scenario/);
  });

  it('runs a lab scenario with the start options passed in and reports every call', async () => {
    plugin
      .rejects('stop', { message: 'camera already stopped' })
      .resolves('isCameraStarted', { value: true })
      .answers('start', (_args, callIndex) =>
        callIndex === 0 ? Promise.resolve() : Promise.reject({ message: 'camera start already in progress' }),
      );

    const result = await api.runScenario('duplicate-start', { start: { position: 'front', toBack: true } });

    expect(result.startOptions).toEqual({ position: 'front', toBack: true });
    expect(plugin.calls.filter((call) => call.method === 'start').map((call) => call.args)).toEqual([
      { position: 'front', toBack: true },
      { position: 'front', toBack: true },
    ]);
    expect(result.groups.length).toBe(1);
    expect(result.groups[0].calls).toEqual([
      jasmine.objectContaining({ label: 'start#1', outcome: 'resolved' }),
      jasmine.objectContaining({ label: 'start#2', outcome: 'rejected', error: 'camera start already in progress' }),
    ]);
    expect(result.unsettled).toBe(0);
    expect(result.checks['isCameraStarted']).toBeTrue();
  });

  it('toggles the chrome, the backdrop and the readiness poll', () => {
    api.setChromeHidden(true);
    api.setBackdrop('rgb(255, 0, 255)');

    expect(ui.chromeHidden()).toBeTrue();
    expect(ui.backdrop()).toBe('rgb(255, 0, 255)');

    api.setBackdrop(null);
    api.setChromeHidden(false);
    expect(ui.backdrop()).toBeNull();
    expect(ui.chromeHidden()).toBeFalse();
  });

  it('reports coverage against the full list', async () => {
    plugin.resolves('start');
    await api.call('start', { position: 'rear' });

    const coverage = api.coverage();

    expect(coverage.exercised).toEqual(['start', 'start.position']);
    expect(coverage.exercised.length + coverage.notExercised.length).toBe(COVERAGE_ITEMS.length);
  });

  it('exports a self-contained record without payloads', async () => {
    plugin.resolves('start').resolves('capture', { value: JPEG_BASE64 });
    await api.call('start', { position: 'rear', toBack: true });
    await api.call('capture', { quality: 85 });

    const record = buildTestRecord(harness, ui);
    const json = JSON.stringify(record);

    expect(record.environment.platform).toBe('android');
    expect(record.sessionOptions).toEqual({ position: 'rear', toBack: true });
    expect(record.lastCall?.method).toBe('capture');
    expect(record.log.length).toBeGreaterThan(0);
    expect(json).not.toContain(JPEG_BASE64.slice(0, 40));
    expect(api.exportRecord().coverage.exercised).toContain('capture.quality');
  });

  it('turns the automatic stop off, cancelling a countdown that is running', async () => {
    plugin.resolves('start').resolves('stop');
    await api.call('start', { position: 'rear', toBack: false });
    harness.armAutoStop(15);
    expect(api.preview().autoStopIn).toBe(15);

    api.setAutoStop(false);

    expect(api.preview().autoStopIn).toBeNull();
    expect(ui.autoStopAllowed()).toBeFalse();

    // Allowed again over a preview that still hides the controls: the countdown starts at once.
    api.setAutoStop(true);
    expect(ui.autoStopAllowed()).toBeTrue();
    expect(api.preview().autoStopIn).toBe(15);
    await api.call('stop');
    expect(api.preview().autoStopIn).toBeNull();
  });

  it('reports where the preview is expected, before and after the viewport turns', async () => {
    plugin.resolves('start').resolves('stop');
    ui.viewport.set({ width: 600, height: 1000 });
    expect(api.preview()).toEqual({ rect: null, source: 'requested', controlBand: null, autoStopIn: null });

    await api.call('start', { position: 'rear', x: 24, y: 96, width: 160, height: 280, toBack: false });
    expect(api.preview()).toEqual({
      rect: { x: 24, y: 96, width: 160, height: 280 },
      source: 'requested',
      controlBand: { top: 376, height: 624 },
      autoStopIn: null,
    });

    ui.viewport.set({ width: 1000, height: 600 });
    ui.viewportChanged();

    expect(api.preview()).toEqual({
      rect: { x: 24, y: 96, width: 280, height: 160 },
      source: 'after-rotation',
      controlBand: { top: 256, height: 344 },
      autoStopIn: null,
    });
    expect(buildTestRecord(harness, ui).preview.source).toBe('after-rotation');
    await api.call('stop');
  });

  describe('autorun', () => {
    it('is disabled for the file shipped in the repository and for malformed input', () => {
      expect(parseAutorunPlan({ enabled: false, steps: [] })).toEqual({ enabled: false, steps: [] });
      expect(parseAutorunPlan({ enabled: true, steps: [] }).enabled).toBeFalse();
      expect(parseAutorunPlan({ enabled: true }).enabled).toBeFalse();
      expect(parseAutorunPlan('enabled').enabled).toBeFalse();
      expect(parseAutorunPlan(null).enabled).toBeFalse();
    });

    it('keeps well-formed steps, drops the rest and caps a wait', () => {
      const plan = parseAutorunPlan({
        enabled: true,
        steps: [
          { call: 'start', args: { position: 'rear' } },
          { scenario: 'no-session' },
          { wait: 999_999 },
          { panel: 'log' },
          { chromeHidden: true },
          { nonsense: true },
          'start',
        ],
      });

      expect(plan.enabled).toBeTrue();
      expect(plan.steps).toEqual([
        { call: 'start', args: { position: 'rear' } },
        { scenario: 'no-session', args: undefined },
        { wait: 60_000 },
        { panel: 'log' },
        { chromeHidden: true },
      ]);
    });

    it('keeps a short message on one line and splits a long one into numbered parts', () => {
      expect(encodeAutorunMessage(AUTORUN_LINE, { step: 'wait', ms: 5 })).toEqual([`${AUTORUN_LINE} {"step":"wait","ms":5}`]);

      const value = { text: 'x'.repeat(250) };
      const lines = encodeAutorunMessage(AUTORUN_DONE, value, 100);
      const json = JSON.stringify(value);

      expect(lines.length).toBe(Math.ceil(json.length / 100));
      let joined = '';
      lines.forEach((line, index) => {
        const [marker, id, position, target, ...piece] = line.split(' ');
        expect(marker).toBe(AUTORUN_PART);
        expect(Number(id)).toBeGreaterThan(0);
        expect(position).toBe(`${index + 1}/${lines.length}`);
        expect(target).toBe(AUTORUN_DONE);
        expect(line.length).toBeLessThan(160);
        joined += piece.join(' ');
      });
      expect(JSON.parse(joined)).toEqual(value);
    });

    it('does nothing for a disabled plan', async () => {
      const lines: string[] = [];

      await runAutorun(api, ui, { enabled: false, steps: [{ call: 'start' }] }, (line) => lines.push(line));

      expect(lines).toEqual([]);
      expect(plugin.calls).toEqual([]);
    });

    it('runs the steps in order and prints one line each, then a done line', async () => {
      plugin.resolves('start').rejects('flip', { message: 'failed to flip camera' });
      const lines: string[] = [];

      await runAutorun(
        api,
        ui,
        parseAutorunPlan({
          enabled: true,
          steps: [{ call: 'start', args: { position: 'rear' } }, { call: 'flip' }, { panel: 'log' }, { call: 'nope' }, { wait: 1 }],
        }),
        (line) => lines.push(line),
      );

      expect(lines.length).toBe(7);
      expect(lines[0].startsWith(`${AUTORUN_LINE} {"environment"`)).toBeTrue();
      expect(JSON.parse(lines[1].slice(AUTORUN_LINE.length)).record.outcome).toBe('resolved');
      expect(JSON.parse(lines[2].slice(AUTORUN_LINE.length)).record.error).toBe('failed to flip camera');
      expect(ui.panel()).toBe('log');
      // A step that throws is reported and does not stop the run.
      expect(JSON.parse(lines[4].slice(AUTORUN_LINE.length)).step).toBe('error');
      expect(lines[6].startsWith(AUTORUN_DONE)).toBeTrue();
      expect(JSON.parse(lines[6].slice(AUTORUN_DONE.length)).steps).toBe(5);
    });
  });
});
