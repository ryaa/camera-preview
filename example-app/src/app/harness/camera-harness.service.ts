import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { CameraPreview } from '@capacitor-community/camera-preview';
import type {
  CameraOpacityOptions,
  CameraPreviewOptions,
  CameraPreviewPictureOptions,
  CameraPreviewPlugin,
  CameraSampleOptions,
} from '@capacitor-community/camera-preview';
import pluginPackage from '@capacitor-community/camera-preview/package.json';

import { coverageIdsForCall, isExpectedUnsupported, normalizePlatform } from './capabilities';
import type { HarnessPlatform, MethodName } from './capabilities';
import { EventLog, errorCode, errorMessage, summarizeValue } from './event-log';
import type { LogEntry } from './event-log';
import { base64ToBytes, bytesToBase64, inspectImage, mimeTypeFor } from './image-inspector';
import type { ImageInfo } from './image-inspector';
import type { RecordVideoOptions } from './option-model';
import { rectAfterOrientationChange, requestedRect, viewportOrientation } from './presets';
import type { CssRect, ViewportMetrics, ViewportOrientation } from './presets';
import { classifyImageResult } from './result-classifier';
import type { ImageMethod, ResultClassification } from './result-classifier';

export type SessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'failed';
export type ReadyValue = boolean | 'unknown' | 'unsupported' | 'error';
export type CallOutcome = 'resolved' | 'rejected' | 'unsettled';
export type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping';

/**
 * Whether a result became the one the harness shows, or why it did not:
 * - `published`: it is (or was, until a newer one arrived) the current result;
 * - `superseded`: a result of a call issued later had already been published;
 * - `session-replaced`: another session was started after the call was issued;
 * - `results-cleared`: the results were cleared (Reset, or Clear in the Results panel) after the
 *   call was issued.
 * In the last three cases the diagnostics stay on the call record as evidence and nothing shown or
 * cached by the harness changes.
 */
export type ResultPublication = 'published' | 'superseded' | 'session-replaced' | 'results-cleared';

/** Where the current preview rectangle comes from. */
export type PreviewRectSource = 'requested' | 'after-rotation';

export interface ImageDiagnostics {
  callId: number;
  method: ImageMethod;
  classification: ResultClassification;
  /** Length of the string the plugin returned (base64 characters, or the path length). */
  returnedLength: number;
  /** The returned path or URL when the result is a file; `null` for base64. */
  returnedPath: string | null;
  /** URL the WebView can load for a file result (`Capacitor.convertFileSrc`). */
  webViewUrl: string | null;
  /** Facts read from the encoded bytes; `null` when the bytes could not be obtained. */
  info: ImageInfo | null;
  readError: string | null;
  /** Rectangle the preview was expected to occupy when the call was issued; `null` on the web. */
  previewRect: CssRect | null;
  /** Width / height of that rectangle. */
  previewAspect: number | null;
  /** Width / height of the image as displayed (EXIF applied). */
  outputAspect: number | null;
  /** (output − preview) / preview, in percent. */
  aspectDeltaPercent: number | null;
  publication: ResultPublication;
}

export interface VideoResult {
  callId: number;
  path: string;
  webViewUrl: string;
  /**
   * Which promise delivered the file. Android resolves it from stop. A file on the start promise
   * is accepted too, for an implementation that resolves it there when the recording ends; iOS
   * declares `{ value }` on that promise but does not record today, so nothing arrives that way.
   */
  deliveredBy: 'startRecordVideo' | 'stopRecordVideo';
  publication: ResultPublication;
}

export interface CallRecord {
  id: number;
  method: MethodName;
  /** Arguments exactly as sent. */
  args: unknown;
  outcome: CallOutcome;
  /** Milliseconds since the harness loaded when the call was issued. */
  atMs: number;
  durationMs: number;
  /** Result with payloads summarised; never contains base64. */
  result?: unknown;
  error?: string;
  errorCode?: string;
  /** True when the rejection comes from a method this platform does not implement. */
  expectedUnsupported: boolean;
  image?: ImageDiagnostics;
  video?: VideoResult;
}

export interface CallResult<T> {
  record: CallRecord;
  /** The raw resolved value; `undefined` unless the call resolved. */
  value?: T;
}

export interface DisplayedImage {
  diagnostics: ImageDiagnostics;
  /** Object URL of the untouched bytes, or `null` when they could not be read. */
  objectUrl: string | null;
}

export interface ReadyState {
  value: ReadyValue;
  /** Milliseconds since the harness loaded when this value was observed. */
  atMs: number;
}

export interface EnvironmentInfo {
  platform: HarnessPlatform;
  native: boolean;
  pluginPackageVersion: string;
  userAgent: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  orientation: string;
}

interface InvokeOptions<T> {
  deadlineMs?: number;
  /** Keeps a high-frequency call (repeated sampling) out of the log. */
  quiet?: boolean;
  /** Runs when a call settles after its deadline, so a late result is not lost. */
  onLateResolve?: (value: T, record: CallRecord) => void;
}

const DEADLINES_MS: Record<MethodName, number> = {
  start: 20_000,
  stop: 10_000,
  isCameraStarted: 5_000,
  flip: 15_000,
  capture: 20_000,
  captureSample: 10_000,
  getSupportedFlashModes: 5_000,
  setFlashMode: 5_000,
  setOpacity: 3_000,
  startRecordVideo: 10_000,
  stopRecordVideo: 15_000,
};

/** The plugin instance the harness drives. Unit tests provide a fake; the app uses the real one. */
export const CAMERA_PREVIEW_PLUGIN = new InjectionToken<CameraPreviewPlugin>('CameraPreviewPlugin', {
  providedIn: 'root',
  factory: () => CameraPreview,
});

/** Platform name as Capacitor reports it; a token so tests can run the native code paths. */
export const HARNESS_PLATFORM = new InjectionToken<HarnessPlatform>('HarnessPlatform', {
  providedIn: 'root',
  factory: () => normalizePlatform(Capacitor.getPlatform()),
});

/**
 * Longest wait for the bytes of a file result. The deadline of the plugin call ends when the call
 * settles, so reading the file it named needs a bound of its own.
 */
export const FILE_READ_DEADLINE_MS = 10_000;

/**
 * What a call needs to remember from the moment it was issued, so that its result is judged against
 * the session that produced it and is published only while that session's results are still wanted.
 */
interface ResultOwner {
  epoch: number;
  session: number;
  storeToFile: boolean | undefined;
  rect: CssRect | null;
}

/**
 * Which recording a lifecycle update belongs to. `epoch` is the generation of sessions that could
 * hold a recording; `id` is the recording operation, 0 for "whatever was current, if anything".
 */
interface RecordingToken {
  epoch: number;
  id: number;
}

interface FileRead {
  controller: AbortController;
  /** Set just before the controller is aborted; becomes the read error. */
  reason: string;
}

/** Geometry kept from `start()` so the rectangle can follow a rotation the way the native view does. */
interface SessionGeometry {
  startRect: CssRect;
  orientation: ViewportOrientation;
  /**
   * Android only: a dimension that was omitted is laid out as "match parent" and follows the
   * viewport until the first rotation, which replaces it with a fixed size.
   */
  followsViewport: { width: boolean; height: boolean };
  paddingBottom: number;
}

const POLL_INTERVAL_MS = 500;
const RETAINED_IMAGES = 12;
const ACTIVE_CLASS = 'camera-preview-active';

function hasStringValue(value: unknown): value is { value: string } {
  return typeof value === 'object' && value !== null && 'value' in value && typeof value.value === 'string';
}

function hasVideoFilePath(value: unknown): value is { videoFilePath: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'videoFilePath' in value &&
    typeof value.videoFilePath === 'string'
  );
}

/**
 * The only place in the example app that calls the plugin.
 *
 * Every call is logged when issued and when it settles, timed, and raced against a deadline so a
 * promise that never settles is reported as `unsettled` instead of leaving the UI waiting. No
 * method here throws: each resolves to a {@link CallResult} describing what happened.
 */
@Injectable({ providedIn: 'root' })
export class CameraHarnessService {
  private readonly plugin = inject(CAMERA_PREVIEW_PLUGIN);

  public readonly platform: HarnessPlatform = inject(HARNESS_PLATFORM);

  public readonly session = signal<SessionState>('idle');
  public readonly ready = signal<ReadyState>({ value: 'unknown', atMs: 0 });
  public readonly recording = signal<RecordingState>('idle');
  public readonly lastCall = signal<CallRecord | null>(null);
  public readonly lastImage = signal<DisplayedImage | null>(null);
  public readonly lastVideo = signal<VideoResult | null>(null);
  public readonly flashModes = signal<readonly string[] | null>(null);
  public readonly log = signal<readonly LogEntry[]>([]);
  public readonly exercised = signal<ReadonlySet<string>>(new Set<string>());
  /** Options of the session being started or running; `null` when idle. */
  public readonly sessionOptions = signal<CameraPreviewOptions | null>(null);
  /**
   * Rectangle the preview is expected to occupy, in CSS pixels; `null` when idle or on the web.
   * It is the rectangle the options ask for until the viewport changes orientation, and after that
   * the one the native layout rules produce (see `rectAfterOrientationChange`).
   */
  public readonly previewRect = signal<CssRect | null>(null);
  public readonly previewRectSource = signal<PreviewRectSource>('requested');
  public readonly sampling = signal<{ ok: number; failed: number } | null>(null);
  /** Seconds left before a preview that covers the controls is stopped automatically. */
  public readonly autoStopIn = signal<number | null>(null);

  public readonly sessionActive = computed(() => this.session() !== 'idle');
  public readonly pendingCount = computed(() => {
    let total = 0;
    for (const count of this.pendingMap().values()) {
      total += count;
    }
    return total;
  });

  private readonly pendingMap = signal<ReadonlyMap<MethodName, number>>(new Map<MethodName, number>());
  private readonly t0 = performance.now();
  private readonly eventLog = new EventLog(undefined, () => performance.now() - this.t0);
  private readonly imageBytes = new Map<number, Uint8Array>();
  private readonly fileReads = new Set<FileRead>();

  private callSeq = 0;
  /** Incremented whenever the results are cleared; a call issued before that no longer publishes. */
  private resultEpoch = 0;
  /** Incremented whenever a session is started; a call issued in an earlier session no longer publishes. */
  private sessionSeq = 0;
  private publishedImageCallId = 0;
  /**
   * Ownership of the `recording` state, kept apart from the ownership of results on purpose:
   * clearing the results hides a video but does not end a recording, and a reset ends a recording
   * whatever is shown. `recordingEpoch` changes when the session that could hold a recording is
   * reset, stopped or replaced; `recordingId` is the recording operation the state describes now
   * (0 for none). A start or stop that settles later changes the state only if it still owns it.
   */
  private recordingEpoch = 0;
  private recordingId = 0;
  private recordingIds = 0;
  private geometry: SessionGeometry | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollBusy = false;
  private pollingAllowed = true;
  private samplingTimer: ReturnType<typeof setInterval> | undefined;
  private autoStopTimer: ReturnType<typeof setInterval> | undefined;
  private metricsProvider: () => ViewportMetrics = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    safeTop: 0,
    dockHeight: 0,
    devicePixelRatio: window.devicePixelRatio,
    platform: this.platform,
  });

  // ---------------------------------------------------------------- plugin methods

  public async start(options: CameraPreviewOptions): Promise<CallResult<void>> {
    const before = this.session();
    const ownsSession = before === 'idle' || before === 'failed';

    if (ownsSession) {
      const metrics = this.metrics();
      const rect = requestedRect(options, metrics);
      this.sessionSeq++;
      this.endRecordingLifecycle();
      this.sessionOptions.set(options);
      this.previewRect.set(rect);
      this.previewRectSource.set('requested');
      this.geometry =
        rect === null
          ? null
          : {
              startRect: rect,
              orientation: viewportOrientation(metrics),
              followsViewport: {
                width: this.platform === 'android' && !(options.width !== undefined && options.width > 0),
                height: this.platform === 'android' && !(options.height !== undefined && options.height > 0),
              },
              paddingBottom: options.paddingBottom ?? 0,
            };
      this.setSession('starting');
    }

    const result = await this.invoke('start', options, () => this.plugin.start(options));

    if (result.record.outcome === 'resolved') {
      this.setSession('running');
    } else if (ownsSession && this.session() === 'starting') {
      // The native preview container can still be attached after a failed start; keep the page
      // transparent and offer "Stop and reset" rather than pretending nothing is there.
      this.setSession('failed');
    }

    return result;
  }

  public async stop(): Promise<CallResult<void>> {
    const before = this.session();
    if (before !== 'idle') {
      this.setSession('stopping');
    }

    const result = await this.invoke('stop', undefined, () => this.plugin.stop());
    const alreadyStopped = /already stopped/i.test(result.record.error ?? '');

    if (result.record.outcome === 'resolved' || alreadyStopped) {
      this.endRecordingLifecycle();
      this.setSession('idle');
    } else if (this.session() === 'stopping') {
      this.setSession(before);
    }

    return result;
  }

  public isCameraStarted(): Promise<CallResult<{ value: boolean }>> {
    return this.invoke('isCameraStarted', undefined, () => this.plugin.isCameraStarted());
  }

  public flip(): Promise<CallResult<void>> {
    return this.invoke('flip', undefined, () => this.plugin.flip());
  }

  public async capture(options: CameraPreviewPictureOptions): Promise<CallResult<{ value: string }>> {
    const owner = this.owner();
    const result = await this.invoke('capture', options, () => this.plugin.capture(options));
    await this.attachImage(result, 'capture', options.quality, owner);
    return result;
  }

  public async captureSample(options: CameraSampleOptions, quiet = false): Promise<CallResult<{ value: string }>> {
    const owner = this.owner();
    const result = await this.invoke('captureSample', options, () => this.plugin.captureSample(options), { quiet });
    await this.attachImage(result, 'captureSample', options.quality, owner);
    return result;
  }

  public async getSupportedFlashModes(): Promise<CallResult<{ result: string[] }>> {
    const owner = this.owner();
    const result = await this.invoke('getSupportedFlashModes', undefined, () => this.plugin.getSupportedFlashModes());
    // The modes belong to the camera of the session that was asked; do not show them for another one.
    if (result.value && Array.isArray(result.value.result) && this.publicationFor(owner) === 'published') {
      this.flashModes.set(result.value.result.slice());
    }
    return result;
  }

  public setFlashMode(options: { flashMode: string }): Promise<CallResult<void>> {
    return this.invoke('setFlashMode', options, () => this.plugin.setFlashMode(options));
  }

  public setOpacity(options: CameraOpacityOptions): Promise<CallResult<void>> {
    return this.invoke('setOpacity', options, () => this.plugin.setOpacity(options));
  }

  public async startRecordVideo(options: RecordVideoOptions): Promise<CallResult<unknown>> {
    const owner = this.owner();
    const token: RecordingToken = { epoch: this.recordingEpoch, id: ++this.recordingIds };
    // With nothing recording, this start is the recording the state describes from now on. With one
    // in progress it is a second start on top of it: the state keeps describing the first one
    // unless this call is accepted.
    if (this.recording() === 'idle') {
      this.recordingId = token.id;
      this.recording.set('starting');
    }

    // A start that does not settle within its deadline is reported as unsettled, and the recording
    // is assumed to be running so that Stop stays available. Should the promise settle later with a
    // file, the late-settlement hook takes that as the end of the recording. No implementation is
    // known to do so today: iOS declares `{ value }` here, but its recorder start and completion
    // handler are commented out, so with a preview running the call never settles and nothing is
    // recorded.
    const result = await this.invoke<unknown>(
      'startRecordVideo',
      options,
      () => this.plugin.startRecordVideo(options),
      { onLateResolve: (value, record) => this.acceptVideo(value, record, 'startRecordVideo', owner, token) },
    );

    if (token.epoch !== this.recordingEpoch || token.id < this.recordingId) {
      // Reset, a stopped or new session, or a newer recording since this call was issued: the
      // outcome is evidence on its record and changes nothing that is current.
      this.note(`startRecordVideo() #${result.record.id}: settled for a recording that is no longer current; state left as it is`);
      this.acceptVideo(result.value, result.record, 'startRecordVideo', owner, token);
    } else if (result.record.outcome === 'rejected') {
      // Only the start that owns the state returns it to idle. A rejected second start leaves the
      // recording in progress as it is.
      if (this.recordingId === token.id) {
        this.recordingId = 0;
        this.recording.set('idle');
      }
    } else {
      this.recordingId = token.id;
      this.recording.set('recording');
      this.acceptVideo(result.value, result.record, 'startRecordVideo', owner, token);
    }

    return result;
  }

  public async stopRecordVideo(): Promise<CallResult<unknown>> {
    const owner = this.owner();
    const token: RecordingToken = { epoch: this.recordingEpoch, id: this.recordingId };
    const before = this.recording();
    this.recording.set('stopping');

    // Declared as Promise<void>, but Android resolves { videoFilePath }. Received as unknown and
    // narrowed, so the wrong declaration is visible here instead of being hidden by a cast.
    const result = await this.invoke<unknown>('stopRecordVideo', undefined, () => this.plugin.stopRecordVideo());

    // The state is touched only if it still describes the recording this call set out to stop.
    const current = this.ownsRecording(token);
    if (!current) {
      this.note(`stopRecordVideo() #${result.record.id}: settled for a recording that is no longer current; state left as it is`);
    }

    if (result.record.outcome === 'rejected') {
      // If a start resolved in the meantime the state already says "recording"; leave that alone.
      if (current && this.recording() === 'stopping') {
        const stillRecording = before === 'recording' && !/not running/i.test(result.record.error ?? '');
        if (!stillRecording) {
          this.recordingId = 0;
        }
        this.recording.set(stillRecording ? before : 'idle');
      }
    } else {
      if (current) {
        this.recordingId = 0;
        this.recording.set('idle');
      }
      this.acceptVideo(result.value, result.record, 'stopRecordVideo', owner, token);
    }

    return result;
  }

  // ---------------------------------------------------------------- session helpers

  /**
   * Safe from any state: stops timers and the preview, clears results, returns to idle. Results of
   * calls still in flight are discarded when they arrive: they stay on their call records and are
   * not shown.
   */
  public async reset(): Promise<void> {
    this.stopSampling();
    this.cancelAutoStop();
    this.note('reset requested');
    // Invalidate first, so nothing issued before the reset can publish a result or change the
    // recording state while stop() is awaited.
    this.clearResults();
    this.endRecordingLifecycle();

    await this.stop();

    this.endRecordingLifecycle();
    this.setSession('idle');
    this.flashModes.set(null);
    // Again, for anything issued and settled while stop() was awaited.
    this.clearResults();
  }

  /**
   * Clears the shown results and the retained bytes, cancels file reads in progress, and stops any
   * call issued before now from publishing its result later.
   */
  public clearResults(): void {
    this.resultEpoch++;
    for (const read of [...this.fileReads]) {
      read.reason = 'cancelled: the results were cleared before the file was read';
      read.controller.abort();
    }
    const current = this.lastImage();
    if (current?.objectUrl) {
      URL.revokeObjectURL(current.objectUrl);
    }
    this.lastImage.set(null);
    this.lastVideo.set(null);
    this.imageBytes.clear();
  }

  /** Calls `captureSample()` on an interval, skipping a tick while the previous sample is pending. */
  public startSampling(intervalMs: number, options: CameraSampleOptions): void {
    this.stopSampling();
    this.sampling.set({ ok: 0, failed: 0 });
    this.note(`repeated sampling started: every ${intervalMs} ms`);

    let busy = false;
    this.samplingTimer = setInterval(() => {
      if (busy) {
        return;
      }
      busy = true;
      void this.captureSample(options, true).then(({ record }) => {
        busy = false;
        const totals = this.sampling();
        if (totals) {
          this.sampling.set(
            record.outcome === 'resolved'
              ? { ok: totals.ok + 1, failed: totals.failed }
              : { ok: totals.ok, failed: totals.failed + 1 },
          );
        }
      });
    }, Math.max(50, intervalMs));
  }

  public stopSampling(): void {
    if (this.samplingTimer === undefined) {
      return;
    }
    clearInterval(this.samplingTimer);
    this.samplingTimer = undefined;
    const totals = this.sampling();
    this.note(`repeated sampling stopped: ${totals?.ok ?? 0} resolved, ${totals?.failed ?? 0} not resolved`);
    this.sampling.set(null);
  }

  /** Stops the preview after `seconds`; the escape for a preview that hides every control. */
  public armAutoStop(seconds: number): void {
    this.cancelAutoStop();
    this.autoStopIn.set(seconds);
    this.note(`auto-stop armed: ${seconds} s`);
    this.autoStopTimer = setInterval(() => {
      const left = (this.autoStopIn() ?? 0) - 1;
      if (left > 0) {
        this.autoStopIn.set(left);
        return;
      }
      this.cancelAutoStop();
      this.note('auto-stop fired');
      void this.stop();
    }, 1000);
  }

  public cancelAutoStop(): void {
    if (this.autoStopTimer !== undefined) {
      clearInterval(this.autoStopTimer);
      this.autoStopTimer = undefined;
    }
    this.autoStopIn.set(null);
  }

  /**
   * Asks the WebView for the microphone, which makes Capacitor request RECORD_AUDIO on Android.
   * The plugin itself never requests it, so recording with audio needs this (or `adb pm grant`).
   */
  public async requestMicrophone(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      this.note('microphone permission: granted');
      return true;
    } catch (error: unknown) {
      this.note(`microphone permission: ${errorMessage(error)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------- observation

  public setMetricsProvider(provider: () => ViewportMetrics): void {
    this.metricsProvider = provider;
  }

  public metrics(): ViewportMetrics {
    return this.metricsProvider();
  }

  /**
   * To be called after the viewport was measured again. While a preview is running, the stored
   * rectangle follows the viewport the way the native view does: a change of orientation applies
   * the platform's rotation rule, and on Android an omitted width or height keeps matching the
   * viewport until the first rotation fixes it.
   *
   * @returns true when the rectangle changed.
   */
  public viewportChanged(): boolean {
    const geometry = this.geometry;
    const current = this.previewRect();
    if (geometry === null || current === null) {
      return false;
    }

    const metrics = this.metrics();
    const orientation = viewportOrientation(metrics);
    let next = current;

    if (orientation !== geometry.orientation) {
      geometry.orientation = orientation;
      geometry.followsViewport = { width: false, height: false };
      next = rectAfterOrientationChange(
        this.platform,
        this.sessionOptions()?.rotateWhenOrientationChanged,
        geometry.startRect,
        current,
        orientation,
      );
      this.previewRectSource.set('after-rotation');
      this.lifecycle(
        `viewport: now ${orientation} (${metrics.width} × ${metrics.height}); preview expected at ` +
          `${Math.round(next.x)}, ${Math.round(next.y)}, ${Math.round(next.width)} × ${Math.round(next.height)}`,
      );
    } else if (geometry.followsViewport.width || geometry.followsViewport.height) {
      next = {
        x: current.x,
        y: current.y,
        width: geometry.followsViewport.width ? metrics.width : current.width,
        height: geometry.followsViewport.height
          ? Math.max(0, metrics.height - geometry.paddingBottom)
          : current.height,
      };
    }

    if (next.x === current.x && next.y === current.y && next.width === current.width && next.height === current.height) {
      return false;
    }
    this.previewRect.set(next);
    return true;
  }

  /** Readiness polling is suspended during automated runs so it cannot interleave with a scenario. */
  public setPollingAllowed(allowed: boolean): void {
    this.pollingAllowed = allowed;
    if (!allowed) {
      this.stopPolling();
    } else if (this.sessionActive()) {
      this.startPolling();
    }
  }

  public note(text: string): void {
    this.addLog({ kind: 'note', text });
  }

  public lifecycle(text: string): void {
    this.addLog({ kind: 'lifecycle', text });
  }

  public clearLog(): void {
    this.eventLog.clear();
    this.log.set([]);
  }

  public isPending(method: MethodName): boolean {
    return (this.pendingMap().get(method) ?? 0) > 0;
  }

  /** Raw bytes of a recent image result as base64, for the automation driver to save untouched. */
  public imageBase64(callId: number): string | null {
    const bytes = this.imageBytes.get(callId);
    return bytes ? bytesToBase64(bytes) : null;
  }

  public environment(): EnvironmentInfo {
    return {
      platform: this.platform,
      native: Capacitor.isNativePlatform(),
      pluginPackageVersion: pluginPackage.version,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screen: { width: window.screen.width, height: window.screen.height },
      orientation: window.screen.orientation?.type ?? 'unknown',
    };
  }

  // ---------------------------------------------------------------- internals

  private async invoke<T>(
    method: MethodName,
    args: unknown,
    call: () => Promise<T>,
    options: InvokeOptions<T> = {},
  ): Promise<CallResult<T>> {
    const id = ++this.callSeq;
    const startedAt = performance.now();
    const deadlineMs = options.deadlineMs ?? DEADLINES_MS[method];
    const quiet = options.quiet === true;
    const record: CallRecord = {
      id,
      method,
      args: args ?? {},
      outcome: 'unsettled',
      atMs: Math.round(startedAt - this.t0),
      durationMs: 0,
      expectedUnsupported: false,
    };

    this.markExercised(method, args);
    this.adjustPending(method, 1);
    if (!quiet) {
      this.addLog({ kind: 'call', callId: id, method, args: summarizeValue(args ?? {}) });
    }

    type Settlement = { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'unsettled' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A plugin method may throw synchronously (the web implementation does); treat it as a rejection.
    const invoked: Promise<T> = (async () => call())();
    const settled: Promise<Settlement> = invoked.then(
      (value): Settlement => ({ kind: 'resolved', value }),
      (error: unknown): Settlement => ({ kind: 'rejected', error }),
    );
    const deadline = new Promise<Settlement>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'unsettled' }), deadlineMs);
    });

    const settlement = await Promise.race([settled, deadline]);
    clearTimeout(timer);
    record.durationMs = Math.round(performance.now() - startedAt);
    this.adjustPending(method, -1);

    let value: T | undefined;
    if (settlement.kind === 'resolved') {
      value = settlement.value;
      record.outcome = 'resolved';
      record.result = summarizeValue(settlement.value ?? null);
      if (!quiet) {
        this.addLog({ kind: 'resolved', callId: id, method, durationMs: record.durationMs, result: record.result });
      }
    } else if (settlement.kind === 'rejected') {
      record.outcome = 'rejected';
      record.error = errorMessage(settlement.error);
      record.errorCode = errorCode(settlement.error);
      record.expectedUnsupported = isExpectedUnsupported(method, this.platform);
      if (!quiet) {
        this.addLog({
          kind: 'rejected',
          callId: id,
          method,
          durationMs: record.durationMs,
          error: record.error,
          expectedUnsupported: record.expectedUnsupported,
        });
      }
    } else {
      this.addLog({ kind: 'unsettled', callId: id, method, durationMs: record.durationMs });
      void settled.then((late) => {
        const afterMs = Math.round(performance.now() - startedAt);
        if (late.kind === 'resolved') {
          this.addLog({ kind: 'late', callId: id, method, durationMs: afterMs, text: 'resolved' });
          options.onLateResolve?.(late.value, record);
        } else if (late.kind === 'rejected') {
          this.addLog({
            kind: 'late',
            callId: id,
            method,
            durationMs: afterMs,
            text: `rejected: ${errorMessage(late.error)}`,
          });
        }
      });
    }

    if (!quiet) {
      this.lastCall.set(record);
    }
    return { record, value };
  }

  /** Captures, when a call is issued, what its result has to be judged against later. */
  private owner(): ResultOwner {
    return {
      epoch: this.resultEpoch,
      session: this.sessionSeq,
      storeToFile: this.sessionOptions()?.storeToFile,
      rect: this.previewRect(),
    };
  }

  /** `callId` is given for image results, where a newer published image must not be replaced. */
  private publicationFor(owner: ResultOwner, callId?: number): ResultPublication {
    if (owner.epoch !== this.resultEpoch) {
      return 'results-cleared';
    }
    if (owner.session !== this.sessionSeq) {
      return 'session-replaced';
    }
    if (callId !== undefined && callId < this.publishedImageCallId) {
      return 'superseded';
    }
    return 'published';
  }

  /**
   * Reads a file result the way an app would display it: through the WebView's file URL. The read
   * ends after {@link FILE_READ_DEADLINE_MS}, or as soon as the results are cleared, even if the
   * WebView never answers.
   */
  private async readFile(url: string): Promise<Uint8Array> {
    const read: FileRead = { controller: new AbortController(), reason: '' };
    this.fileReads.add(read);
    const timer = setTimeout(() => {
      read.reason = `the file was not read within ${FILE_READ_DEADLINE_MS} ms`;
      read.controller.abort();
    }, FILE_READ_DEADLINE_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      read.controller.signal.addEventListener('abort', () => reject(new Error(read.reason)), { once: true });
    });
    const fetched = (async () => {
      const response = await fetch(url, { signal: read.controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} reading ${url}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    })();
    // When the abort wins the race, the fetch rejects later with nobody waiting for it.
    fetched.catch(() => undefined);

    try {
      return await Promise.race([fetched, aborted]);
    } finally {
      clearTimeout(timer);
      this.fileReads.delete(read);
    }
  }

  private async attachImage(
    result: CallResult<{ value: string }>,
    method: ImageMethod,
    quality: number | undefined,
    owner: ResultOwner,
  ): Promise<void> {
    if (!hasStringValue(result.value)) {
      return;
    }

    // Everything below is judged against the session that issued the call (`owner`), never against
    // the state at the time the result arrives: the session may have been reset or replaced since.
    const returned = result.value.value;
    const classification = classifyImageResult(returned, {
      platform: this.platform,
      method,
      storeToFile: owner.storeToFile,
      quality,
    });
    const isFile = classification.detected.kind === 'file';
    const diagnostics: ImageDiagnostics = {
      callId: result.record.id,
      method,
      classification,
      returnedLength: returned.length,
      returnedPath: isFile ? returned : null,
      webViewUrl: isFile ? Capacitor.convertFileSrc(returned) : null,
      info: null,
      readError: null,
      previewRect: owner.rect,
      previewAspect: null,
      outputAspect: null,
      aspectDeltaPercent: null,
      publication: 'published',
    };

    let bytes: Uint8Array | null = null;
    try {
      if (classification.detected.kind === 'base64') {
        bytes = base64ToBytes(returned);
      } else if (diagnostics.webViewUrl !== null) {
        bytes = await this.readFile(diagnostics.webViewUrl);
      } else {
        diagnostics.readError = 'The returned value is neither image data nor a file reference.';
      }
    } catch (error: unknown) {
      diagnostics.readError = errorMessage(error);
    }

    // Decided only now, after the last await: a reset or a restart during the read counts too.
    const publication = this.publicationFor(owner, result.record.id);
    const invalidated = publication === 'results-cleared' || publication === 'session-replaced';
    diagnostics.publication = publication;

    if (bytes !== null) {
      diagnostics.info = inspectImage(bytes);
      if (!invalidated) {
        this.rememberBytes(result.record.id, bytes);
      }
    }

    const rect = owner.rect;
    const info = diagnostics.info;
    if (rect && rect.height > 0) {
      diagnostics.previewAspect = rect.width / rect.height;
    }
    if (info?.displayWidth && info.displayHeight) {
      diagnostics.outputAspect = info.displayWidth / info.displayHeight;
    }
    if (diagnostics.previewAspect !== null && diagnostics.outputAspect !== null) {
      diagnostics.aspectDeltaPercent =
        ((diagnostics.outputAspect - diagnostics.previewAspect) / diagnostics.previewAspect) * 100;
    }

    result.record.image = diagnostics;

    if (publication !== 'published') {
      this.note(`${method}() #${result.record.id}: result kept on its call record only (${publication})`);
      return;
    }
    this.publishedImageCallId = result.record.id;

    const previous = this.lastImage();
    if (previous?.objectUrl) {
      URL.revokeObjectURL(previous.objectUrl);
    }
    const objectUrl =
      bytes !== null && info
        ? URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeTypeFor(info.format) }))
        : null;
    this.lastImage.set({ diagnostics, objectUrl });
  }

  private ownsRecording(token: RecordingToken): boolean {
    return token.epoch === this.recordingEpoch && token.id === this.recordingId;
  }

  /** Ends whatever was recording: no start or stop issued before now may change the state again. */
  private endRecordingLifecycle(): void {
    this.recordingEpoch++;
    this.recordingId = 0;
    this.recording.set('idle');
  }

  private acceptVideo(
    value: unknown,
    record: CallRecord,
    deliveredBy: VideoResult['deliveredBy'],
    owner: ResultOwner,
    token: RecordingToken,
  ): void {
    let path: string | null = null;
    if (hasVideoFilePath(value)) {
      path = value.videoFilePath;
    } else if (deliveredBy === 'startRecordVideo' && hasStringValue(value)) {
      path = value.value;
    }
    if (path === null) {
      return;
    }

    const publication = this.publicationFor(owner);
    const video: VideoResult = {
      callId: record.id,
      path,
      webViewUrl: Capacitor.convertFileSrc(path),
      deliveredBy,
      publication,
    };
    record.video = video;

    // Lifecycle first, and whether or not the video will be shown: a file on the start promise
    // means that recording has ended. Only the recording the state still describes may say so.
    if (deliveredBy === 'startRecordVideo' && this.ownsRecording(token)) {
      this.recordingId = 0;
      this.recording.set('idle');
    }

    if (publication !== 'published') {
      // A recording of a session that was reset or replaced, or results cleared since: evidence on
      // its record, nothing shown.
      this.note(`${deliveredBy}() #${record.id}: video kept on its call record only (${publication})`);
      return;
    }
    this.lastVideo.set(video);
  }

  private rememberBytes(callId: number, bytes: Uint8Array): void {
    this.imageBytes.set(callId, bytes);
    while (this.imageBytes.size > RETAINED_IMAGES) {
      const oldest = this.imageBytes.keys().next();
      if (oldest.done) {
        break;
      }
      this.imageBytes.delete(oldest.value);
    }
  }

  private setSession(state: SessionState): void {
    if (this.session() !== state) {
      this.session.set(state);
    }

    const active = state !== 'idle';
    // The page must be transparent for a preview behind the WebView to show through.
    document.documentElement.classList.toggle(ACTIVE_CLASS, active);

    if (active) {
      this.startPolling();
    } else {
      this.stopPolling();
      this.stopSampling();
      this.cancelAutoStop();
      this.sessionOptions.set(null);
      this.previewRect.set(null);
      this.previewRectSource.set('requested');
      this.geometry = null;
      this.ready.set({ value: 'unknown', atMs: this.now() });
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined || !this.pollingAllowed || this.ready().value === 'unsupported') {
      return;
    }
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Polls directly (not through `invoke`) so two calls a second do not flood the log. */
  private async pollOnce(): Promise<void> {
    if (this.pollBusy) {
      return;
    }
    this.pollBusy = true;

    let next: ReadyValue;
    try {
      next = (await this.plugin.isCameraStarted()).value;
    } catch (error: unknown) {
      next = errorCode(error) === 'UNIMPLEMENTED' || this.platform === 'web' ? 'unsupported' : 'error';
    } finally {
      this.pollBusy = false;
    }

    if (next !== this.ready().value) {
      this.addLog({ kind: 'readiness', text: `isCameraStarted(): ${String(this.ready().value)} → ${String(next)}` });
    }
    this.ready.set({ value: next, atMs: this.now() });
    if (next === 'unsupported') {
      this.stopPolling();
    }
  }

  private markExercised(method: MethodName, args: unknown): void {
    const current = this.exercised();
    const ids = coverageIdsForCall(method, args).filter((id) => !current.has(id));
    if (ids.length > 0) {
      this.exercised.set(new Set([...current, ...ids]));
    }
  }

  private adjustPending(method: MethodName, delta: number): void {
    const next = new Map(this.pendingMap());
    const count = (next.get(method) ?? 0) + delta;
    if (count > 0) {
      next.set(method, count);
    } else {
      next.delete(method);
    }
    this.pendingMap.set(next);
  }

  private addLog(input: Parameters<EventLog['add']>[0]): void {
    this.eventLog.add(input);
    this.log.set(this.eventLog.snapshot());
  }

  private now(): number {
    return Math.round(performance.now() - this.t0);
  }
}
