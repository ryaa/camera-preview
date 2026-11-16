import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CAMERA_PREVIEW_PLUGIN, CameraHarnessService, HARNESS_PLATFORM } from '../harness/camera-harness.service';
import { COVERAGE_ITEMS } from '../harness/capabilities';
import { HarnessUiService } from '../harness/harness-ui.service';
import { bytesToBase64 } from '../harness/image-inspector';
import { startFormFromOptions } from '../harness/option-model';
import { FakeCameraPreview } from '../harness/testing/fake-camera-preview';
import { pngFixture } from '../harness/testing/image-fixtures';

import { HomePage } from './home.page';

describe('HomePage', () => {
  let plugin: FakeCameraPreview;
  let fixture: ComponentFixture<HomePage>;
  let element: HTMLElement;
  let harness: CameraHarnessService;
  let ui: HarnessUiService;

  const byTestId = (id: string): HTMLElement | null => element.querySelector(`[data-testid="${id}"]`);
  const click = (id: string): void => {
    const target = byTestId(id);
    if (!target) {
      throw new Error(`no element with data-testid="${id}"`);
    }
    target.click();
    fixture.detectChanges();
  };
  const stable = async (): Promise<void> => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(platform: 'android' | 'ios' | 'web' = 'android'): Promise<void> {
    plugin = new FakeCameraPreview();
    plugin.resolves('start').resolves('stop').resolves('isCameraStarted', { value: true });
    TestBed.configureTestingModule({
      providers: [
        { provide: CAMERA_PREVIEW_PLUGIN, useValue: plugin },
        { provide: HARNESS_PLATFORM, useValue: platform },
      ],
    });
    fixture = TestBed.createComponent(HomePage);
    element = fixture.nativeElement;
    harness = TestBed.inject(CameraHarnessService);
    ui = TestBed.inject(HarnessUiService);
    harness.setPollingAllowed(false);
    fixture.detectChanges();
    await stable();
  }

  afterEach(() => {
    fixture.destroy();
    document.documentElement.classList.remove('camera-preview-active');
  });

  it('creates the shell with six tabs and the dock', async () => {
    await create();

    expect(fixture.componentInstance).toBeTruthy();
    expect(element.querySelectorAll('.cph-tab').length).toBe(6);
    for (const id of ['dock-start', 'dock-stop', 'dock-capture', 'dock-sample', 'dock-flip']) {
      expect(byTestId(id)).withContext(id).not.toBeNull();
    }
    expect(byTestId('platform')?.textContent).toContain('android');
  });

  it('publishes the automation entry point and removes it on destroy', async () => {
    await create();
    expect(window.__cameraPreviewHarness?.version).toBe(1);

    fixture.destroy();
    expect(window.__cameraPreviewHarness).toBeUndefined();
  });

  it('shows exactly the options that will be sent and sends them on Start', async () => {
    await create();
    click('preset-footer');
    click('start-enableZoom-true');

    const shown = JSON.parse(byTestId('start-options-json')?.textContent ?? '{}');
    expect(shown.disableExifHeaderStripping).toBeFalse();
    expect(shown.enableZoom).toBeTrue();
    expect('height' in shown).toBeFalse();
    expect(shown.paddingBottom).toBeGreaterThan(0);

    click('dock-start');
    await stable();

    expect(plugin.calls.find((call) => call.method === 'start')?.args).toEqual(shown);
    expect(harness.session()).toBe('running');
    expect(byTestId('dock-start')?.textContent).toContain('Restart');
  });

  it('removes a key again when its control goes back to unset', async () => {
    await create();
    click('start-storeToFile-true');
    expect(JSON.parse(byTestId('start-options-json')?.textContent ?? '{}').storeToFile).toBeTrue();

    click('start-storeToFile-unset');
    expect('storeToFile' in JSON.parse(byTestId('start-options-json')?.textContent ?? '{}')).toBeFalse();
  });

  it('warns before a preview that would cover the controls and arms the automatic stop', async () => {
    await create();
    click('start-toBack-false');

    expect(element.querySelector('.cph-warn')?.textContent).toContain('covers the page');

    click('config-start');
    // The countdown is an interval, so the zone is not stable while it runs; wait a tick instead.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fixture.detectChanges();

    expect(harness.autoStopIn()).toBe(15);
    expect(byTestId('status')?.textContent).toContain('auto-stop in 15 s');

    // Stopping ends the countdown.
    click('dock-stop');
    await stable();
    expect(harness.autoStopIn()).toBeNull();
    expect(harness.session()).toBe('idle');
  });

  it('confines the shell to the free band beside a preview in front of the page', async () => {
    await create();
    ui.viewport.set({ width: 400, height: 800 });
    click('preset-wide');
    click('dock-start');
    await stable();

    const shell = byTestId('shell');
    expect(shell?.classList.contains('cph-shell-band')).toBeTrue();
    expect(parseFloat(shell?.style.top ?? '0')).toBeGreaterThan(100);
    expect(byTestId('guide')).not.toBeNull();
  });

  it('offers "Stop and reset" after a failed start', async () => {
    await create();
    plugin.rejects('start', { message: 'Permission failed: user denied access to camera.' });
    plugin.rejects('stop', { message: 'camera already stopped' });

    click('dock-start');
    await stable();
    expect(harness.session()).toBe('failed');
    expect(byTestId('status-last')?.textContent).toContain('Permission failed');

    click('dock-reset');
    await stable();
    expect(harness.session()).toBe('idle');
    expect(byTestId('dock-start')).not.toBeNull();
  });

  it('hides everything in peek mode and restores it from the chip', async () => {
    await create();
    click('dock-start');
    await stable();

    click('peek');
    expect(byTestId('shell')?.classList.contains('cph-shell-peek')).toBeTrue();

    click('peek-chip');
    expect(byTestId('shell')?.classList.contains('cph-shell-peek')).toBeFalse();
  });

  it('labels JPEG metadata as not applicable for a PNG result', async () => {
    await create('web');
    plugin.resolves('capture', { value: bytesToBase64(pngFixture(640, 480)) });
    ui.captureForm.set({ ...ui.captureForm(), quality: { send: false, value: 85 } });

    click('dock-capture');
    await stable();

    expect(ui.panel()).toBe('results');
    const facts = byTestId('result-facts')?.textContent ?? '';
    expect(facts).toContain('PNG');
    expect(facts).toContain('not applicable (PNG)');
    expect(facts).toContain('640 × 480');
    expect(facts).not.toContain('no EXIF block');
  });

  it('lists every method and option in the coverage panel and ticks what was exercised', async () => {
    await create();
    click('dock-start');
    await stable();
    click('tab-coverage');

    expect(element.querySelectorAll('[data-coverage-id]').length).toBe(COVERAGE_ITEMS.length);
    expect(element.querySelector('[data-coverage-id="start"]')?.classList.contains('cph-done')).toBeTrue();
    expect(element.querySelector('[data-coverage-id="flip"]')?.classList.contains('cph-done')).toBeFalse();
    expect(byTestId('coverage-count')?.textContent).toMatch(/of 39 exercised/);
  });

  it('shows an expected rejection as such in the log on a platform that lacks the method', async () => {
    await create('web');
    plugin.rejects('flip', new Error('flip not supported under the web platform'));

    click('dock-flip');
    await stable();
    click('tab-log');

    expect(byTestId('log-list')?.textContent).toContain('unsupported on this platform — expected');
  });

  it('runs a lab scenario from its button and tabulates the outcomes', async () => {
    await create();
    plugin
      .rejects('stop', { message: 'camera already stopped' })
      .rejects('capture', { message: 'Camera is not running' })
      .rejects('captureSample', { message: 'Camera is not running' })
      .rejects('flip', { message: 'Camera is not running' })
      .rejects('getSupportedFlashModes', { message: 'Camera is not running' })
      .rejects('setFlashMode', { message: 'Camera is not running' })
      .rejects('setOpacity', { message: 'Camera is not running' })
      .rejects('startRecordVideo', { message: 'Camera is not running' })
      .rejects('stopRecordVideo', { message: 'Camera is not running' })
      .resolves('isCameraStarted', { value: false });
    click('tab-lab');

    click('lab-no-session');
    await stable();
    await stable();

    const result = byTestId('lab-result');
    expect(result?.textContent).toContain('every call settled');
    expect(result?.querySelectorAll('tbody tr').length).toBe(10);
  });

  describe('when the device turns while a preview is running', () => {
    let size = { width: 400, height: 800 };
    const resize = (width: number, height: number): void => {
      size = { width, height };
      window.dispatchEvent(new Event('resize'));
      fixture.detectChanges();
    };
    const guideBox = (): string => {
      const style = byTestId('guide')?.style;
      return style ? [style.left, style.top, style.width, style.height].join(' ') : 'no guide';
    };

    beforeEach(() => {
      size = { width: 400, height: 800 };
      spyOnProperty(window, 'innerWidth').and.callFake(() => size.width);
      spyOnProperty(window, 'innerHeight').and.callFake(() => size.height);
    });

    it('moves the guide and the control band with an explicit rectangle', async () => {
      await create();
      resize(600, 1000);
      ui.startForm.set(startFormFromOptions({ position: 'rear', x: 24, y: 96, width: 160, height: 280, toBack: false }));
      click('dock-start');
      await stable();

      expect(guideBox()).toBe('24px 96px 160px 280px');
      expect(byTestId('guide')?.textContent).toContain('requested 160 × 280');
      expect(byTestId('shell')?.style.top).toBe('376px');

      resize(1000, 600);

      // Android keeps the origin and exchanges the sides; the viewport is not substituted.
      expect(guideBox()).toBe('24px 96px 280px 160px');
      expect(byTestId('guide')?.textContent).toContain('expected after rotation 280 × 160');
      // The controls move to the band the turned rectangle leaves free, and stay reachable.
      expect(byTestId('shell')?.classList.contains('cph-shell-band')).toBeTrue();
      expect(byTestId('shell')?.style.top).toBe('256px');
      expect(byTestId('shell')?.style.height).toBe('344px');
      expect(harness.autoStopIn()).toBeNull();
    });

    it('arms the automatic stop when the turned preview leaves no band for the controls', async () => {
      await create();
      resize(400, 800);
      ui.startForm.set(startFormFromOptions({ position: 'rear', x: 24, y: 96, width: 160, height: 280, toBack: false }));
      click('dock-start');
      await stable();
      expect(harness.autoStopIn()).toBeNull();

      resize(800, 400);

      // 96 px above and 144 px below the rectangle: neither band can hold the controls.
      expect(ui.shellBand()).toBeNull();
      expect(harness.autoStopIn()).toBe(15);
      expect(byTestId('status')?.textContent).toContain('auto-stop in 15 s');

      click('dock-stop');
      await stable();
      expect(harness.autoStopIn()).toBeNull();
    });

    it('arms the automatic stop when a wide rectangle stays as it is but the room for the controls is gone', async () => {
      await create();
      resize(400, 800);
      ui.startForm.set(startFormFromOptions({ position: 'rear', x: 40, y: 120, width: 300, height: 200, toBack: false }));
      click('dock-start');
      await stable();
      expect(byTestId('shell')?.style.top).toBe('320px');
      expect(harness.autoStopIn()).toBeNull();

      resize(800, 400);

      // Android keeps a wide rectangle unchanged on the turn to landscape …
      expect(guideBox()).toBe('40px 120px 300px 200px');
      // … but only 120 px above it and 80 px below remain, so the escape has to be armed.
      expect(byTestId('shell')?.classList.contains('cph-shell-band')).toBeFalse();
      expect(harness.autoStopIn()).toBe(15);
      expect(byTestId('status')?.textContent).toContain('auto-stop in 15 s');

      click('dock-stop');
      await stable();
      expect(harness.autoStopIn()).toBeNull();
    });

    it('cancels that countdown when the device is turned back and the controls are reachable again', async () => {
      await create();
      resize(400, 800);
      ui.startForm.set(startFormFromOptions({ position: 'rear', x: 24, y: 96, width: 160, height: 280, toBack: false }));
      click('dock-start');
      await stable();
      resize(800, 400);
      expect(harness.autoStopIn()).toBe(15);

      resize(400, 800);

      expect(guideBox()).toBe('24px 96px 160px 280px');
      expect(ui.shellBand()).toEqual({ top: 376, height: 424 });
      expect(harness.autoStopIn()).toBeNull();
      expect(harness.session()).toBe('running');
      await stable();
    });

    it('arms no countdown for an automated driver that turned it off', async () => {
      await create();
      resize(400, 800);
      window.__cameraPreviewHarness?.setAutoStop(false);
      ui.startForm.set(startFormFromOptions({ position: 'rear', toBack: false }));
      click('dock-start');
      await stable();
      expect(harness.autoStopIn()).toBeNull();

      resize(800, 400);

      expect(ui.shellBand()).toBeNull();
      expect(harness.autoStopIn()).toBeNull();
      expect(harness.session()).toBe('running');
    });

    it('turns a full-screen preview behind the page without confining or stopping anything', async () => {
      await create();
      resize(400, 800);
      click('dock-start');
      await stable();
      expect(guideBox()).toBe('0px 0px 400px 800px');

      resize(800, 400);

      expect(guideBox()).toBe('0px 0px 800px 400px');
      expect(byTestId('shell')?.classList.contains('cph-shell-band')).toBeFalse();
      expect(harness.autoStopIn()).toBeNull();
      expect(harness.session()).toBe('running');
    });

    it('compares a capture taken after the turn with the turned rectangle', async () => {
      await create();
      resize(400, 800);
      ui.startForm.set(startFormFromOptions({ position: 'rear', x: 24, y: 96, width: 160, height: 280, toBack: true }));
      click('dock-start');
      await stable();
      resize(800, 400);
      plugin.resolves('capture', { value: bytesToBase64(pngFixture(640, 480)) });

      click('dock-capture');
      await stable();

      expect(harness.lastImage()?.diagnostics.previewRect).toEqual({ x: 24, y: 96, width: 280, height: 160 });
      expect(harness.lastImage()?.diagnostics.previewAspect).toBeCloseTo(1.75, 5);
    });
  });
});
