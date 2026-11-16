import { TestBed, discardPeriodicTasks, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';

import {
  CAMERA_PREVIEW_PLUGIN,
  CameraHarnessService,
  FILE_READ_DEADLINE_MS,
  HARNESS_PLATFORM,
} from './camera-harness.service';
import type { CallResult } from './camera-harness.service';
import type { HarnessPlatform } from './capabilities';
import { bytesToBase64 } from './image-inspector';
import { FakeCameraPreview } from './testing/fake-camera-preview';
import { jpegFixture, pngFixture } from './testing/image-fixtures';

const JPEG = jpegFixture({ width: 1280, height: 720, exif: { orientation: 6 } });
const JPEG_BASE64 = bytesToBase64(JPEG);
const ANDROID_PATH = '/data/user/0/com.example.app/cache/cpcp_capture_1a145bf2.jpg';

describe('CameraHarnessService', () => {
  let plugin: FakeCameraPreview;
  let service: CameraHarnessService;
  /** What the metrics provider reports; a test turns the "device" by replacing it. */
  let viewport = { width: 400, height: 800 };

  function create(platform: HarnessPlatform = 'android'): void {
    viewport = { width: 400, height: 800 };
    plugin = new FakeCameraPreview();
    TestBed.configureTestingModule({
      providers: [
        { provide: CAMERA_PREVIEW_PLUGIN, useValue: plugin },
        { provide: HARNESS_PLATFORM, useValue: platform },
      ],
    });
    service = TestBed.inject(CameraHarnessService);
    // The status-strip poll would otherwise interleave with every test.
    service.setPollingAllowed(false);
    service.setMetricsProvider(() => ({
      width: viewport.width,
      height: viewport.height,
      safeTop: 0,
      dockHeight: 60,
      devicePixelRatio: 2,
      platform,
    }));
  }

  /** Awaits a harness call under fakeAsync, advancing the clock by `ms` if given. */
  function settle<T>(promise: Promise<CallResult<T>>, ms = 0): CallResult<T> {
    let result: CallResult<T> | undefined;
    void promise.then((value) => (result = value));
    tick(ms);
    flushMicrotasks();
    if (!result) {
      throw new Error('the harness call did not settle');
    }
    return result;
  }

  /** Turns the "device" and tells the service, as the page does after a resize event. */
  function turn(width: number, height: number): boolean {
    viewport = { width, height };
    return service.viewportChanged();
  }

  /** A `fetch` whose response the test supplies later, to hold a file read open. */
  function deferredFetch(): { respond(response: Response): void; signal(): AbortSignal | null; calls(): number } {
    let respond: (response: Response) => void = () => undefined;
    let signal: AbortSignal | null = null;
    const spy = spyOn(window, 'fetch').and.callFake((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    return { respond: (response) => respond(response), signal: () => signal, calls: () => spy.calls.count() };
  }

  /** Real-time wait for a condition, for the tests that involve a real `Response`. */
  async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!condition()) {
      throw new Error('the awaited condition did not become true');
    }
  }

  afterEach(() => {
    document.documentElement.classList.remove('camera-preview-active');
  });

  describe('session state', () => {
    beforeEach(() => create());

    it('goes idle → starting → running and makes the page transparent', fakeAsync(() => {
      const pending = plugin.settlesLater('start');
      const call = service.start({ position: 'rear', toBack: true });
      flushMicrotasks();

      expect(service.session()).toBe('starting');
      expect(service.isPending('start')).toBeTrue();
      expect(document.documentElement.classList.contains('camera-preview-active')).toBeTrue();

      pending.resolve();
      const { record } = settle(call);

      expect(record.outcome).toBe('resolved');
      expect(service.session()).toBe('running');
      expect(service.isPending('start')).toBeFalse();
      expect(service.sessionOptions()).toEqual({ position: 'rear', toBack: true });
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 400, height: 800 });
    }));

    it('returns to idle on stop and restores the page', fakeAsync(() => {
      plugin.resolves('start').resolves('stop');
      settle(service.start({}));
      settle(service.stop());

      expect(service.session()).toBe('idle');
      expect(service.sessionOptions()).toBeNull();
      expect(service.previewRect()).toBeNull();
      expect(document.documentElement.classList.contains('camera-preview-active')).toBeFalse();
    }));

    it('is "failed" after a rejected first start, keeping the page transparent until reset', fakeAsync(() => {
      plugin.rejects('start', { message: 'Permission failed: user denied access to camera.' }).rejects('stop', {
        message: 'camera already stopped',
      });

      const { record } = settle(service.start({}));
      expect(record.outcome).toBe('rejected');
      expect(record.error).toBe('Permission failed: user denied access to camera.');
      expect(service.session()).toBe('failed');
      expect(document.documentElement.classList.contains('camera-preview-active')).toBeTrue();

      void service.reset();
      flushMicrotasks();
      expect(service.session()).toBe('idle');
    }));

    it('keeps a running session untouched when a duplicate start is rejected', fakeAsync(() => {
      plugin.resolves('start');
      settle(service.start({ position: 'rear' }));
      plugin.rejects('start', { message: 'camera already started' });

      const { record } = settle(service.start({ position: 'front' }));

      expect(record.error).toBe('camera already started');
      expect(service.session()).toBe('running');
      expect(service.sessionOptions()).toEqual({ position: 'rear' });
    }));

    it('treats "camera already stopped" as idle', fakeAsync(() => {
      plugin.resolves('start').rejects('stop', { message: 'camera already stopped' });
      settle(service.start({}));
      settle(service.stop());

      expect(service.session()).toBe('idle');
    }));

    it('stays in the previous state when stop fails for another reason', fakeAsync(() => {
      plugin.resolves('start').rejects('stop', { message: 'something else' });
      settle(service.start({}));
      settle(service.stop());

      expect(service.session()).toBe('running');
    }));
  });

  describe('settlement and deadlines', () => {
    beforeEach(() => create());

    it('reports a call that never settles as unsettled and releases its pending flag', fakeAsync(() => {
      plugin.neverSettles('setOpacity');
      let result: CallResult<void> | undefined;
      void service.setOpacity({ opacity: 0.5 }).then((value) => (result = value));

      tick(2999);
      expect(result).toBeUndefined();
      expect(service.isPending('setOpacity')).toBeTrue();

      tick(1);
      flushMicrotasks();
      expect(result?.record.outcome).toBe('unsettled');
      // A control bound to this flag must never stay disabled.
      expect(service.isPending('setOpacity')).toBeFalse();
      expect(service.pendingCount()).toBe(0);
      expect(service.log().some((entry) => entry.kind === 'unsettled' && entry.method === 'setOpacity')).toBeTrue();
    }));

    it('logs a settlement that arrives after the deadline', fakeAsync(() => {
      const pending = plugin.settlesLater('setOpacity');
      const { record } = settle(service.setOpacity({ opacity: 1 }), 3000);
      expect(record.outcome).toBe('unsettled');

      pending.resolve();
      flushMicrotasks();

      const late = service.log().filter((entry) => entry.kind === 'late');
      expect(late.length).toBe(1);
      expect(late[0].text).toBe('resolved');
      expect(late[0].callId).toBe(record.id);
    }));

    it('turns a synchronous throw into a rejection', fakeAsync(() => {
      plugin.throws('flip', new Error('flip exploded'));

      const { record } = settle(service.flip());

      expect(record.outcome).toBe('rejected');
      expect(record.error).toBe('flip exploded');
      expect(record.expectedUnsupported).toBeFalse();
    }));

    it('counts overlapping calls to one method separately', fakeAsync(() => {
      const first = plugin.settlesLater('capture');
      const one = service.capture({ quality: 85 });
      flushMicrotasks();
      const second = plugin.settlesLater('capture');
      const two = service.capture({ quality: 85 });
      flushMicrotasks();
      expect(service.pendingCount()).toBe(2);

      first.reject({ message: 'A capture is already in progress' });
      settle(one);
      expect(service.isPending('capture')).toBeTrue();

      second.reject({ message: 'camera stopped before the capture completed' });
      settle(two);
      expect(service.isPending('capture')).toBeFalse();
    }));

    it('records the arguments exactly as sent and the error code', fakeAsync(() => {
      plugin.rejects('setFlashMode', { message: 'Flash mode not recognised: strobe', code: 'X' });

      const { record } = settle(service.setFlashMode({ flashMode: 'strobe' }));

      expect(record.args).toEqual({ flashMode: 'strobe' });
      expect(record.error).toBe('Flash mode not recognised: strobe');
      expect(record.errorCode).toBe('X');
    }));
  });

  describe('unsupported methods', () => {
    it('marks a web rejection of a method the web lacks as expected', fakeAsync(() => {
      create('web');
      plugin.rejects('flip', new Error('flip not supported under the web platform'));

      const { record } = settle(service.flip());

      expect(record.outcome).toBe('rejected');
      expect(record.expectedUnsupported).toBeTrue();
      expect(service.log().find((entry) => entry.kind === 'rejected')?.expectedUnsupported).toBeTrue();
    }));

    it('does not excuse the same rejection on Android', fakeAsync(() => {
      create('android');
      plugin.rejects('flip', new Error('failed to flip camera'));

      expect(settle(service.flip()).record.expectedUnsupported).toBeFalse();
    }));
  });

  describe('image results', () => {
    beforeEach(() => create());

    it('reads a base64 JPEG from its bytes and keeps the payload out of the log', fakeAsync(() => {
      plugin.resolves('start').resolves('capture', { value: JPEG_BASE64 });
      settle(service.start({ position: 'rear', toBack: true }));

      const { record } = settle(service.capture({ quality: 85 }));
      const image = record.image;

      expect(image?.classification.consistent).toBeTrue();
      expect(image?.classification.detected).toEqual({ kind: 'base64', format: 'jpeg' });
      expect(image?.returnedPath).toBeNull();
      expect(image?.returnedLength).toBe(JPEG_BASE64.length);
      expect(image?.info?.encodedWidth).toBe(1280);
      expect(image?.info?.encodedHeight).toBe(720);
      expect(image?.info?.jpeg?.orientation).toBe(6);
      expect(image?.info?.displayWidth).toBe(720);
      expect(service.lastImage()?.objectUrl).toMatch(/^blob:/);
      expect(service.imageBase64(record.id)).toBe(JPEG_BASE64);
      expect(JSON.stringify(service.log())).not.toContain(JPEG_BASE64.slice(0, 40));
      expect(JSON.stringify(record.result)).toBe(JSON.stringify({ value: `base64[${JPEG_BASE64.length}]` }));
    }));

    it('compares the output aspect with the requested preview rectangle', fakeAsync(() => {
      plugin.resolves('start').resolves('capture', { value: JPEG_BASE64 });
      settle(service.start({ x: 0, y: 0, width: 300, height: 200, toBack: false }));

      const image = settle(service.capture({ quality: 85 })).record.image;

      expect(image?.previewAspect).toBeCloseTo(1.5, 5);
      expect(image?.outputAspect).toBeCloseTo(720 / 1280, 5);
      expect(image?.aspectDeltaPercent).toBeCloseTo(-62.5, 3);
    }));

    it('reads a file result through the WebView URL', async () => {
      plugin.resolves('start').resolves('capture', { value: ANDROID_PATH });
      const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JPEG.slice().buffer));
      await service.start({ storeToFile: true });

      const { record } = await service.capture({ quality: 85 });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(record.image?.classification.consistent).toBeTrue();
      expect(record.image?.returnedPath).toBe(ANDROID_PATH);
      expect(record.image?.webViewUrl).toContain('cpcp_capture_1a145bf2.jpg');
      expect(record.image?.info?.format).toBe('jpeg');
      expect(record.image?.readError).toBeNull();
    });

    it('classifies an Android sample as base64 even with storeToFile: true', fakeAsync(() => {
      plugin.resolves('start').resolves('captureSample', { value: JPEG_BASE64 });
      settle(service.start({ storeToFile: true }));

      const image = settle(service.captureSample({ quality: 85 })).record.image;

      expect(image?.classification.expected.kind).toBe('base64');
      expect(image?.classification.detected.kind).toBe('base64');
      expect(image?.classification.consistent).toBeTrue();
      expect(image?.webViewUrl).toBeNull();
    }));

    it('flags base64 returned where a file was expected', fakeAsync(() => {
      plugin.resolves('start').resolves('capture', { value: JPEG_BASE64 });
      settle(service.start({ storeToFile: true }));

      expect(settle(service.capture({ quality: 85 })).record.image?.classification.consistent).toBeFalse();
    }));

    it('reports a file that cannot be read without failing the call', async () => {
      plugin.resolves('start').resolves('capture', { value: ANDROID_PATH });
      spyOn(window, 'fetch').and.resolveTo(new Response('', { status: 404 }));
      await service.start({ storeToFile: true });

      const { record } = await service.capture({ quality: 85 });

      expect(record.outcome).toBe('resolved');
      expect(record.image?.info).toBeNull();
      expect(record.image?.readError).toContain('404');
      expect(service.lastImage()?.objectUrl).toBeNull();
    });

    it('attaches no image to a rejected capture', fakeAsync(() => {
      plugin.rejects('capture', { message: 'Camera is not running' });

      expect(settle(service.capture({})).record.image).toBeUndefined();
      expect(service.lastImage()).toBeNull();
    }));
  });

  it('recognises a web PNG result when quality is omitted', fakeAsync(() => {
    create('web');
    plugin.resolves('capture', { value: bytesToBase64(pngFixture(640, 480)) });

    const image = settle(service.capture({})).record.image;

    expect(image?.classification.consistent).toBeTrue();
    expect(image?.info?.format).toBe('png');
    expect(image?.info?.jpeg).toBeNull();
    expect(image?.previewAspect).toBeNull();
  }));

  describe('recording results', () => {
    it('takes the Android file from stopRecordVideo(), which the typings declare as void', fakeAsync(() => {
      create('android');
      plugin.resolves('startRecordVideo').resolves('stopRecordVideo', { videoFilePath: '/data/user/0/app/cache/videoTmp.mp4' });

      settle(service.startRecordVideo({ withFlash: true, maxDuration: 1500 }));
      expect(service.recording()).toBe('recording');

      const { record } = settle(service.stopRecordVideo());

      expect(record.video?.path).toBe('/data/user/0/app/cache/videoTmp.mp4');
      expect(record.video?.deliveredBy).toBe('stopRecordVideo');
      expect(service.lastVideo()?.callId).toBe(record.id);
      expect(service.recording()).toBe('idle');
    }));

    // No current implementation delivers a file this way (iOS declares it but does not record), so
    // the path is exercised with an explicit mock.
    it('takes a file from a startRecordVideo() promise that settles late', fakeAsync(() => {
      create('ios');
      const pending = plugin.settlesLater('startRecordVideo');

      const { record } = settle(service.startRecordVideo({}), 10_000);
      expect(record.outcome).toBe('unsettled');
      expect(service.recording()).toBe('recording');

      pending.resolve({ value: 'file:///tmp/video.mp4' });
      flushMicrotasks();

      expect(service.lastVideo()?.deliveredBy).toBe('startRecordVideo');
      expect(service.lastVideo()?.path).toBe('file:///tmp/video.mp4');
      expect(service.recording()).toBe('idle');
    }));

    it('returns to idle when startRecordVideo() rejects', fakeAsync(() => {
      create('android');
      plugin.rejects('startRecordVideo', { message: 'Camera is not running' });

      settle(service.startRecordVideo({}));

      expect(service.recording()).toBe('idle');
      expect(service.lastVideo()).toBeNull();
    }));
  });

  describe('observation', () => {
    beforeEach(() => create());

    it('stores the flash modes the camera reports', fakeAsync(() => {
      plugin.resolves('getSupportedFlashModes', { result: ['off', 'auto', 'on', 'torch'] });

      settle(service.getSupportedFlashModes());

      expect(service.flashModes()).toEqual(['off', 'auto', 'on', 'torch']);
    }));

    it('marks methods and sent option keys as exercised', fakeAsync(() => {
      plugin.resolves('start').resolves('capture', { value: JPEG_BASE64 });
      settle(service.start({ position: 'rear', paddingBottom: 56 }));
      settle(service.capture({ quality: 85, width: 640 }));

      expect([...service.exercised()].sort()).toEqual(
        ['capture', 'capture.quality', 'capture.width', 'start', 'start.paddingBottom', 'start.position'].sort(),
      );
    }));

    it('logs readiness only when it changes', fakeAsync(() => {
      plugin.resolves('start').resolves('stop').resolves('isCameraStarted', { value: true });
      service.setPollingAllowed(true);
      settle(service.start({}));
      tick(2000);
      flushMicrotasks();

      const transitions = service.log().filter((entry) => entry.kind === 'readiness');
      expect(transitions.length).toBe(1);
      expect(transitions[0].text).toBe('isCameraStarted(): unknown → true');
      expect(service.ready().value).toBe(true);
      expect(plugin.countOf('isCameraStarted')).toBeGreaterThan(2);

      settle(service.stop());
      discardPeriodicTasks();
    }));

    it('stops the preview when the auto-stop timer runs out', fakeAsync(() => {
      plugin.resolves('start').resolves('stop');
      settle(service.start({ toBack: false }));
      service.armAutoStop(3);

      tick(2000);
      expect(service.autoStopIn()).toBe(1);
      expect(plugin.countOf('stop')).toBe(0);

      tick(1000);
      flushMicrotasks();
      expect(plugin.countOf('stop')).toBe(1);
      expect(service.session()).toBe('idle');
      expect(service.autoStopIn()).toBeNull();
    }));

    it('counts repeated samples without logging each one', fakeAsync(() => {
      plugin.resolves('start').resolves('stop').resolves('captureSample', { value: JPEG_BASE64 });
      settle(service.start({}));
      const before = service.log().length;

      service.startSampling(100, { quality: 85 });
      tick(350);
      flushMicrotasks();

      expect(service.sampling()?.ok).toBe(3);
      expect(service.log().filter((entry) => entry.method === 'captureSample').length).toBe(0);
      expect(service.log().length).toBe(before + 1);

      service.stopSampling();
      expect(service.sampling()).toBeNull();
      settle(service.stop());
    }));

    it('describes the environment for the test record', () => {
      const environment = service.environment();

      expect(environment.platform).toBe('android');
      expect(environment.pluginPackageVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(environment.viewport.width).toBeGreaterThan(0);
    });
  });

  describe('rotation while a preview is running', () => {
    it('exchanges the sides of a full-screen Android preview and marks the rectangle as rotated', fakeAsync(() => {
      create('android');
      plugin.resolves('start');
      settle(service.start({ position: 'rear', toBack: true }));
      expect(service.previewRectSource()).toBe('requested');

      expect(turn(800, 400)).toBeTrue();

      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 800, height: 400 });
      expect(service.previewRectSource()).toBe('after-rotation');
      expect(service.log().some((entry) => entry.kind === 'lifecycle' && /now landscape/.test(entry.text ?? ''))).toBeTrue();

      expect(turn(400, 800)).toBeTrue();
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 400, height: 800 });
    }));

    it('keeps the origin of an offset rectangle instead of substituting the viewport', fakeAsync(() => {
      create('android');
      plugin.resolves('start');
      settle(service.start({ x: 24, y: 96, width: 160, height: 280, toBack: false }));

      turn(800, 400);

      expect(service.previewRect()).toEqual({ x: 24, y: 96, width: 280, height: 160 });
    }));

    it('leaves a wide explicit rectangle alone in landscape and exchanges it on the way back', fakeAsync(() => {
      create('android');
      plugin.resolves('start');
      settle(service.start({ x: 40, y: 120, width: 300, height: 200, toBack: false }));

      expect(turn(800, 400)).toBeFalse();
      expect(service.previewRect()).toEqual({ x: 40, y: 120, width: 300, height: 200 });

      expect(turn(400, 800)).toBeTrue();
      expect(service.previewRect()).toEqual({ x: 40, y: 120, width: 200, height: 300 });
    }));

    it('lets omitted Android dimensions follow a resize until the first rotation fixes them', fakeAsync(() => {
      create('android');
      plugin.resolves('start');
      settle(service.start({ toBack: true, paddingBottom: 56 }));
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 400, height: 744 });

      // Same orientation, smaller viewport (split screen, for example).
      expect(turn(400, 700)).toBeTrue();
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 400, height: 644 });
      expect(service.previewRectSource()).toBe('requested');

      turn(700, 400);
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 644, height: 400 });

      // From now on the size is a fixed one and a plain resize no longer moves it.
      expect(turn(720, 400)).toBeFalse();
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 644, height: 400 });
    }));

    it('does not let an explicit rectangle follow a resize', fakeAsync(() => {
      create('android');
      plugin.resolves('start');
      settle(service.start({ x: 24, y: 96, width: 160, height: 280, toBack: false }));

      expect(turn(400, 700)).toBeFalse();
      expect(service.previewRect()).toEqual({ x: 24, y: 96, width: 160, height: 280 });
    }));

    it('follows the iOS rule: origin transposed and the longer side across in landscape', fakeAsync(() => {
      create('ios');
      plugin.resolves('start');
      // iOS divides x and y by the screen scale (2 here), so these are 24 and 96 points.
      settle(service.start({ x: 48, y: 192, width: 160, height: 280, toBack: false }));
      expect(service.previewRect()).toEqual({ x: 24, y: 96, width: 160, height: 280 });

      turn(800, 400);
      expect(service.previewRect()).toEqual({ x: 96, y: 24, width: 280, height: 160 });

      turn(400, 800);
      expect(service.previewRect()).toEqual({ x: 24, y: 96, width: 160, height: 280 });
    }));

    it('moves nothing on iOS with rotateWhenOrientationChanged: false', fakeAsync(() => {
      create('ios');
      plugin.resolves('start');
      settle(service.start({ width: 160, height: 280, rotateWhenOrientationChanged: false }));

      expect(turn(800, 400)).toBeFalse();
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 160, height: 280 });
    }));

    it('compares a capture with the rectangle of the moment it was issued', fakeAsync(() => {
      create('android');
      plugin.resolves('start');
      settle(service.start({ x: 24, y: 96, width: 160, height: 280, toBack: false }));

      const pending = plugin.settlesLater('capture');
      const before = service.capture({ quality: 85 });
      flushMicrotasks();
      turn(800, 400);
      pending.resolve({ value: JPEG_BASE64 });
      const issuedBefore = settle(before).record.image;

      plugin.resolves('capture', { value: JPEG_BASE64 });
      const issuedAfter = settle(service.capture({ quality: 85 })).record.image;

      expect(issuedBefore?.previewRect).toEqual({ x: 24, y: 96, width: 160, height: 280 });
      expect(issuedBefore?.previewAspect).toBeCloseTo(160 / 280, 5);
      expect(issuedAfter?.previewRect).toEqual({ x: 24, y: 96, width: 280, height: 160 });
      expect(issuedAfter?.previewAspect).toBeCloseTo(1.75, 5);
      expect(issuedAfter?.aspectDeltaPercent).toBeCloseTo(((720 / 1280 - 1.75) / 1.75) * 100, 3);
    }));

    it('has nothing to follow when idle, and starts the next session from the new viewport', fakeAsync(() => {
      create('android');
      plugin.resolves('start').resolves('stop');
      expect(turn(800, 400)).toBeFalse();

      settle(service.start({ toBack: true }));
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 800, height: 400 });
      expect(service.previewRectSource()).toBe('requested');

      turn(400, 800);
      settle(service.stop());
      expect(service.previewRect()).toBeNull();
      expect(service.previewRectSource()).toBe('requested');
    }));

    it('has no rectangle to move on the web', fakeAsync(() => {
      create('web');
      plugin.resolves('start');
      settle(service.start({ parent: 'cph-web-preview' }));

      expect(turn(800, 400)).toBeFalse();
      expect(service.previewRect()).toBeNull();
    }));
  });

  describe('result ownership across reset and restart', () => {

    it('does not bring an image back when the capture resolves after a reset', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('stop');
      settle(service.start({ position: 'rear', toBack: true }));
      const pending = plugin.settlesLater('capture');
      const call = service.capture({ quality: 85 });
      flushMicrotasks();

      void service.reset();
      flushMicrotasks();
      expect(service.session()).toBe('idle');
      expect(service.lastImage()).toBeNull();

      pending.resolve({ value: JPEG_BASE64 });
      const { record } = settle(call);

      expect(record.outcome).toBe('resolved');
      expect(record.image?.publication).toBe('results-cleared');
      // The evidence stays on the call record …
      expect(record.image?.info?.encodedWidth).toBe(1280);
      // … and nothing the harness shows or retains changes.
      expect(service.lastImage()).toBeNull();
      expect(service.imageBase64(record.id)).toBeNull();
      expect(service.session()).toBe('idle');
      expect(service.log().some((entry) => /kept on its call record only \(results-cleared\)/.test(entry.text ?? ''))).toBeTrue();
    }));

    it('cancels a file read when the results are reset, and ignores a late answer', async () => {
      create();
      plugin.resolves('start').resolves('stop').resolves('capture', { value: ANDROID_PATH });
      const file = deferredFetch();
      await service.start({ storeToFile: true });

      const pending = service.capture({ quality: 85 });
      await until(() => file.calls() === 1);
      await service.reset();
      const { record } = await pending;

      expect(file.signal()?.aborted).toBeTrue();
      expect(record.image?.publication).toBe('results-cleared');
      expect(record.image?.readError).toContain('cancelled');
      expect(record.image?.info).toBeNull();
      expect(service.lastImage()).toBeNull();
      expect(service.imageBase64(record.id)).toBeNull();

      file.respond(new Response(JPEG.slice().buffer));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.lastImage()).toBeNull();
      expect(service.imageBase64(record.id)).toBeNull();
    });

    it('judges a capture against the session that issued it when another one has started since', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('stop');
      settle(service.start({ x: 0, y: 0, width: 300, height: 200, toBack: false }));
      const pending = plugin.settlesLater('capture');
      const call = service.capture({ quality: 85 });
      flushMicrotasks();

      settle(service.stop());
      settle(service.start({ toBack: true, storeToFile: true }));
      pending.resolve({ value: JPEG_BASE64 });
      const { record } = settle(call);

      expect(record.image?.publication).toBe('session-replaced');
      // base64 was the right kind of result for the first session, whatever the second one asks for.
      expect(record.image?.classification.expected.kind).toBe('base64');
      expect(record.image?.classification.consistent).toBeTrue();
      expect(record.image?.previewRect).toEqual({ x: 0, y: 0, width: 300, height: 200 });
      expect(record.image?.previewAspect).toBeCloseTo(1.5, 5);
      expect(service.lastImage()).toBeNull();
      expect(service.imageBase64(record.id)).toBeNull();
      expect(service.sessionOptions()).toEqual({ toBack: true, storeToFile: true });
      expect(service.previewRect()).toEqual({ x: 0, y: 0, width: 400, height: 800 });
    }));

    it('keeps a file result of a replaced session as evidence only', async () => {
      create();
      plugin.resolves('start').resolves('stop').resolves('capture', { value: ANDROID_PATH });
      const file = deferredFetch();
      await service.start({ x: 0, y: 0, width: 300, height: 200, toBack: false, storeToFile: true });

      const pending = service.capture({ quality: 85 });
      await until(() => file.calls() === 1);
      await service.stop();
      await service.start({ toBack: true });
      file.respond(new Response(JPEG.slice().buffer));
      const { record } = await pending;

      expect(record.image?.publication).toBe('session-replaced');
      expect(record.image?.classification.expected.kind).toBe('file');
      expect(record.image?.classification.consistent).toBeTrue();
      expect(record.image?.info?.encodedWidth).toBe(1280);
      expect(record.image?.previewAspect).toBeCloseTo(1.5, 5);
      expect(service.lastImage()).toBeNull();
      expect(service.imageBase64(record.id)).toBeNull();
    });

    it('bounds the file read, which the deadline of the plugin call does not cover', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('capture', { value: ANDROID_PATH });
      spyOn(window, 'fetch').and.returnValue(new Promise<Response>(() => undefined));
      settle(service.start({ storeToFile: true }));

      let result: CallResult<{ value: string }> | undefined;
      void service.capture({ quality: 85 }).then((value) => (result = value));
      flushMicrotasks();

      tick(FILE_READ_DEADLINE_MS - 1);
      flushMicrotasks();
      expect(result).toBeUndefined();

      tick(1);
      flushMicrotasks();
      expect(result?.record.outcome).toBe('resolved');
      expect(result?.record.image?.readError).toContain(`not read within ${FILE_READ_DEADLINE_MS} ms`);
      expect(result?.record.image?.info).toBeNull();
      expect(result?.record.image?.publication).toBe('published');
      expect(service.lastImage()?.objectUrl).toBeNull();
    }));

    it('does not let an older result replace a newer one', fakeAsync(() => {
      create();
      plugin.resolves('start');
      settle(service.start({ toBack: true }));
      const first = plugin.settlesLater('capture');
      const one = service.capture({ quality: 85 });
      flushMicrotasks();
      const second = plugin.settlesLater('capture');
      const two = service.capture({ quality: 85 });
      flushMicrotasks();

      second.resolve({ value: JPEG_BASE64 });
      const newer = settle(two).record;
      first.resolve({ value: bytesToBase64(jpegFixture({ width: 640, height: 480 })) });
      const older = settle(one).record;

      expect(newer.image?.publication).toBe('published');
      expect(older.image?.publication).toBe('superseded');
      expect(service.lastImage()?.diagnostics.callId).toBe(newer.id);
      // A merely older result of the same session is still valid; its bytes stay retrievable.
      expect(service.imageBase64(older.id)).not.toBeNull();
    }));

    it('still shows a capture that resolves after a plain stop', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('stop');
      settle(service.start({ toBack: true }));
      const pending = plugin.settlesLater('capture');
      const call = service.capture({ quality: 85 });
      flushMicrotasks();

      settle(service.stop());
      pending.resolve({ value: JPEG_BASE64 });
      const { record } = settle(call);

      expect(record.image?.publication).toBe('published');
      expect(record.image?.previewRect).toEqual({ x: 0, y: 0, width: 400, height: 800 });
      expect(service.lastImage()?.diagnostics.callId).toBe(record.id);
    }));

    it('does not publish a result when the Results panel was cleared in the meantime', fakeAsync(() => {
      create();
      plugin.resolves('start');
      settle(service.start({ toBack: true }));
      const pending = plugin.settlesLater('captureSample');
      const call = service.captureSample({ quality: 85 });
      flushMicrotasks();

      service.clearResults();
      pending.resolve({ value: JPEG_BASE64 });

      expect(settle(call).record.image?.publication).toBe('results-cleared');
      expect(service.lastImage()).toBeNull();
      expect(service.session()).toBe('running');
    }));

    it('does not bring a recording back when a start promise delivers it after a reset', fakeAsync(() => {
      create('ios');
      plugin.rejects('stop', { message: 'camera already stopped' });
      const pending = plugin.settlesLater('startRecordVideo');
      const { record } = settle(service.startRecordVideo({}), 10_000);
      expect(record.outcome).toBe('unsettled');

      void service.reset();
      flushMicrotasks();
      pending.resolve({ value: 'file:///tmp/video.mp4' });
      flushMicrotasks();

      expect(record.video?.publication).toBe('results-cleared');
      expect(record.video?.path).toBe('file:///tmp/video.mp4');
      expect(service.lastVideo()).toBeNull();
      expect(service.recording()).toBe('idle');
    }));

    it('does not show the flash modes of a camera whose session was replaced', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('stop');
      settle(service.start({ position: 'rear' }));
      const pending = plugin.settlesLater('getSupportedFlashModes');
      const call = service.getSupportedFlashModes();
      flushMicrotasks();

      settle(service.stop());
      settle(service.start({ position: 'front' }));
      pending.resolve({ result: ['off', 'torch'] });
      const { record } = settle(call);

      expect(record.outcome).toBe('resolved');
      expect(service.flashModes()).toBeNull();
    }));
  });

  describe('recording state ownership', () => {
    const VIDEO = { videoFilePath: '/data/user/0/app/cache/videoTmp.mp4' };

    it('stays idle when a start that was pending at a reset runs into its deadline', fakeAsync(() => {
      create();
      plugin.neverSettles('startRecordVideo').rejects('stop', { message: 'camera already stopped' });
      const call = service.startRecordVideo({});
      flushMicrotasks();
      expect(service.recording()).toBe('starting');

      void service.reset();
      flushMicrotasks();
      expect(service.session()).toBe('idle');
      expect(service.recording()).toBe('idle');

      const { record } = settle(call, 10_000);

      expect(record.outcome).toBe('unsettled');
      expect(service.session()).toBe('idle');
      // Before the correction this was "recording", which left the Start recording button disabled.
      expect(service.recording()).toBe('idle');
    }));

    it('stays idle when such a start resolves after the reset, and keeps its video as evidence only', fakeAsync(() => {
      create();
      plugin.rejects('stop', { message: 'camera already stopped' });
      const pending = plugin.settlesLater('startRecordVideo');
      const call = service.startRecordVideo({});
      flushMicrotasks();

      void service.reset();
      flushMicrotasks();
      pending.resolve({ value: 'file:///tmp/video.mp4' });
      const { record } = settle(call);

      expect(record.outcome).toBe('resolved');
      expect(record.video?.publication).toBe('results-cleared');
      expect(service.lastVideo()).toBeNull();
      expect(service.recording()).toBe('idle');
    }));

    it('does not let a start of a stopped session mark the next session as recording', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('stop');
      settle(service.start({ position: 'rear' }));
      const pending = plugin.settlesLater('startRecordVideo');
      const call = service.startRecordVideo({});
      flushMicrotasks();

      settle(service.stop());
      expect(service.recording()).toBe('idle');
      settle(service.start({ position: 'front' }));
      pending.resolve();
      settle(call);

      expect(service.session()).toBe('running');
      expect(service.recording()).toBe('idle');
      expect(service.log().some((entry) => /no longer current/.test(entry.text ?? ''))).toBeTrue();
    }));

    it('does not let a stop of a stopped session change a recording of the next session', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('stop').resolves('startRecordVideo');
      settle(service.start({ position: 'rear' }));
      settle(service.startRecordVideo({}));
      const oldStop = plugin.settlesLater('stopRecordVideo');
      const call = service.stopRecordVideo();
      flushMicrotasks();

      settle(service.stop());
      settle(service.start({ position: 'front' }));
      settle(service.startRecordVideo({}));
      expect(service.recording()).toBe('recording');
      oldStop.resolve(VIDEO);
      const { record } = settle(call);

      // The new recording is still running; the old file is evidence of the old session only.
      expect(service.recording()).toBe('recording');
      expect(record.video?.publication).toBe('session-replaced');
      expect(service.lastVideo()).toBeNull();
    }));

    it('does not let a late file of an earlier recording end a newer one', fakeAsync(() => {
      create();
      const first = plugin.settlesLater('startRecordVideo');
      const firstCall = settle(service.startRecordVideo({}), 10_000).record;
      expect(firstCall.outcome).toBe('unsettled');
      expect(service.recording()).toBe('recording');

      plugin.resolves('stopRecordVideo', VIDEO).resolves('startRecordVideo');
      settle(service.stopRecordVideo());
      expect(service.recording()).toBe('idle');
      settle(service.startRecordVideo({}));
      expect(service.recording()).toBe('recording');

      first.resolve({ value: 'file:///tmp/first.mp4' });
      flushMicrotasks();

      expect(firstCall.video?.path).toBe('file:///tmp/first.mp4');
      expect(service.recording()).toBe('recording');
    }));

    it('does not let a stop of an earlier recording mark a newer one idle', fakeAsync(() => {
      create();
      plugin.resolves('startRecordVideo');
      settle(service.startRecordVideo({}));
      const oldStop = plugin.settlesLater('stopRecordVideo');
      const stopCall = service.stopRecordVideo();
      flushMicrotasks();
      expect(service.recording()).toBe('stopping');

      // A second start is accepted while that stop is still pending: it is the recording now.
      settle(service.startRecordVideo({}));
      expect(service.recording()).toBe('recording');
      oldStop.resolve(VIDEO);
      const { record } = settle(stopCall);

      expect(record.video?.path).toBe(VIDEO.videoFilePath);
      expect(service.recording()).toBe('recording');
    }));

    it('leaves a recording in progress alone when a second start is rejected', fakeAsync(() => {
      create();
      plugin.resolves('startRecordVideo');
      settle(service.startRecordVideo({}));
      plugin.rejects('startRecordVideo', { message: 'a video recording is already in progress' });

      const { record } = settle(service.startRecordVideo({}));

      expect(record.outcome).toBe('rejected');
      expect(service.recording()).toBe('recording');

      plugin.resolves('stopRecordVideo', VIDEO);
      settle(service.stopRecordVideo());
      expect(service.recording()).toBe('idle');
    }));

    it('returns to idle when the current recording stops after Clear, and keeps that video hidden', fakeAsync(() => {
      create();
      plugin.resolves('start').resolves('startRecordVideo');
      settle(service.start({ position: 'rear' }));
      settle(service.startRecordVideo({}));
      const pending = plugin.settlesLater('stopRecordVideo');
      const call = service.stopRecordVideo();
      flushMicrotasks();

      // Clear hides results; it does not end the recording or invalidate its lifecycle.
      service.clearResults();
      expect(service.recording()).toBe('stopping');
      pending.resolve(VIDEO);
      const { record } = settle(call);

      expect(service.recording()).toBe('idle');
      expect(record.video?.publication).toBe('results-cleared');
      expect(service.lastVideo()).toBeNull();
      expect(service.session()).toBe('running');
    }));

    it('returns to idle when a start promise delivers the file after Clear, and keeps that video hidden', fakeAsync(() => {
      create();
      const pending = plugin.settlesLater('startRecordVideo');
      const { record } = settle(service.startRecordVideo({}), 10_000);
      expect(service.recording()).toBe('recording');

      service.clearResults();
      expect(service.recording()).toBe('recording');
      pending.resolve({ value: 'file:///tmp/video.mp4' });
      flushMicrotasks();

      expect(service.recording()).toBe('idle');
      expect(record.video?.publication).toBe('results-cleared');
      expect(service.lastVideo()).toBeNull();
    }));

    it('shows the video of a recording that is stopped after Clear', fakeAsync(() => {
      create();
      plugin.resolves('startRecordVideo').resolves('stopRecordVideo', VIDEO);
      settle(service.startRecordVideo({}));
      service.clearResults();

      const { record } = settle(service.stopRecordVideo());

      expect(record.video?.publication).toBe('published');
      expect(service.lastVideo()?.path).toBe(VIDEO.videoFilePath);
      expect(service.recording()).toBe('idle');
    }));

    it('keeps "recording" when a stop is rejected for a reason other than nothing running', fakeAsync(() => {
      create();
      plugin.resolves('startRecordVideo').rejects('stopRecordVideo', { message: 'encoder busy' });
      settle(service.startRecordVideo({}));

      settle(service.stopRecordVideo());

      expect(service.recording()).toBe('recording');
    }));

    it('follows a start that resolves while a stop issued too early is being rejected', fakeAsync(() => {
      create();
      const start = plugin.settlesLater('startRecordVideo');
      const startCall = service.startRecordVideo({});
      flushMicrotasks();
      const stop = plugin.settlesLater('stopRecordVideo');
      const stopCall = service.stopRecordVideo();
      flushMicrotasks();

      start.resolve();
      settle(startCall);
      expect(service.recording()).toBe('recording');
      stop.reject({ message: 'nothing is recording yet' });
      settle(stopCall);

      // The recording did start; the rejected stop must not report it as idle.
      expect(service.recording()).toBe('recording');
    }));
  });
});
