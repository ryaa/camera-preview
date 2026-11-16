import type { CallRecord, CameraHarnessService, EnvironmentInfo } from './camera-harness.service';
import { COVERAGE_ITEMS, METHOD_NAMES } from './capabilities';
import type { MethodName } from './capabilities';
import type { LogEntry } from './event-log';
import { PANELS } from './harness-ui.service';
import type { HarnessUiService } from './harness-ui.service';
import {
  parseFlashOptions,
  parseOpacityOptions,
  parsePictureOptions,
  parseRecordOptions,
  parseSampleOptions,
  parseStartOptions,
} from './option-model';
import type { CssRect, ViewportMetrics } from './presets';
import { LAB_SCENARIOS, defaultStartOptions, findScenario, runScenario } from './scenarios';
import type { LabResult } from './scenarios';

/**
 * Automation entry point, published as `window.__cameraPreviewHarness`.
 *
 * A driver (Chrome DevTools Protocol on Android and the web, the autorun file on iOS) calls these
 * functions instead of clicking, so an automated run executes exactly the code a manual run does:
 * the same service wrapper, the same deadlines, the same diagnostics. It is example-app surface
 * only; nothing here exists in the plugin.
 */
export interface HarnessAutomationApi {
  readonly version: 1;
  environment(): EnvironmentInfo & { metrics: ViewportMetrics };
  /**
   * Where the harness expects the running preview, in CSS pixels, and whether that is the rectangle
   * the options asked for or the one the native layout rules give after a rotation.
   */
  preview(): PreviewState;
  methods(): readonly MethodName[];
  /**
   * Issues one plugin call through the harness and resolves to its record, whatever the outcome.
   * Rejects only for a method name the plugin does not have, which is a driver error.
   */
  call(method: string, args?: unknown): Promise<CallRecord>;
  /** Runs a Lab concurrency scenario. `args.start` overrides the start options it uses. */
  runScenario(id: string, args?: unknown): Promise<LabResult>;
  scenarios(): string[];
  /** Untouched bytes of a recent capture/sample result, base64 encoded; `null` if not retained. */
  imageBase64(callId: number): string | null;
  log(): LogEntry[];
  clearLog(): void;
  /** Hides or restores every harness element, so a host screenshot shows only the preview. */
  setChromeHidden(hidden: boolean): void;
  /** Paints the page one opaque CSS colour (or clears it with `null`) to measure a preview in front of it. */
  setBackdrop(color: string | null): void;
  /** Turns the status-strip readiness poll off (or back on) so it cannot interleave with a run. */
  setPolling(enabled: boolean): void;
  /**
   * Turns off (or back on) the automatic stop of a preview that hides the controls. A driver needs
   * no controls, and the countdown must not end a preview in the middle of a run.
   */
  setAutoStop(enabled: boolean): void;
  coverage(): { exercised: string[]; notExercised: string[] };
  exportRecord(): TestRecord;
  reset(): Promise<void>;
}

export interface PreviewState {
  rect: CssRect | null;
  source: 'requested' | 'after-rotation';
  /** Band the controls are confined to beside a preview in front of the page; `null` for the whole viewport. */
  controlBand: { top: number; height: number } | null;
  autoStopIn: number | null;
}

/** One self-contained JSON document describing a run; what "Export test record" produces. */
export interface TestRecord {
  exportedAt: string;
  environment: EnvironmentInfo & { metrics: ViewportMetrics };
  sessionOptions: unknown;
  preview: PreviewState;
  lastCall: CallRecord | null;
  lastImage: unknown;
  lastVideo: unknown;
  coverage: { exercised: string[]; notExercised: string[] };
  log: LogEntry[];
}

declare global {
  interface Window {
    __cameraPreviewHarness?: HarnessAutomationApi;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMethodName(value: string): value is MethodName {
  return METHOD_NAMES.some((name) => name === value);
}

export function buildTestRecord(harness: CameraHarnessService, ui: HarnessUiService): TestRecord {
  return {
    exportedAt: new Date().toISOString(),
    environment: { ...harness.environment(), metrics: ui.metrics() },
    sessionOptions: harness.sessionOptions(),
    preview: previewState(harness, ui),
    lastCall: harness.lastCall(),
    lastImage: harness.lastImage()?.diagnostics ?? null,
    lastVideo: harness.lastVideo(),
    coverage: coverageSummary(harness),
    log: harness.log().slice(),
  };
}

export function previewState(harness: CameraHarnessService, ui: HarnessUiService): PreviewState {
  return {
    rect: harness.previewRect(),
    source: harness.previewRectSource(),
    controlBand: ui.shellBand(),
    autoStopIn: harness.autoStopIn(),
  };
}

export function coverageSummary(harness: CameraHarnessService): { exercised: string[]; notExercised: string[] } {
  const exercised = harness.exercised();
  return {
    exercised: COVERAGE_ITEMS.filter((item) => exercised.has(item.id)).map((item) => item.id),
    notExercised: COVERAGE_ITEMS.filter((item) => !exercised.has(item.id)).map((item) => item.id),
  };
}

export function createAutomationApi(harness: CameraHarnessService, ui: HarnessUiService): HarnessAutomationApi {
  const call = async (method: string, args?: unknown): Promise<CallRecord> => {
    if (!isMethodName(method)) {
      throw new Error(`harness: unknown method "${method}"`);
    }

    switch (method) {
      case 'start':
        return (await harness.start(parseStartOptions(args).options)).record;
      case 'stop':
        return (await harness.stop()).record;
      case 'isCameraStarted':
        return (await harness.isCameraStarted()).record;
      case 'flip':
        return (await harness.flip()).record;
      case 'capture':
        return (await harness.capture(parsePictureOptions(args))).record;
      case 'captureSample':
        return (await harness.captureSample(parseSampleOptions(args))).record;
      case 'getSupportedFlashModes':
        return (await harness.getSupportedFlashModes()).record;
      case 'setFlashMode':
        return (await harness.setFlashMode(parseFlashOptions(args))).record;
      case 'setOpacity':
        return (await harness.setOpacity(parseOpacityOptions(args))).record;
      case 'startRecordVideo':
        return (await harness.startRecordVideo(parseRecordOptions(args))).record;
      case 'stopRecordVideo':
        return (await harness.stopRecordVideo()).record;
    }
  };

  return {
    version: 1,
    environment: () => ({ ...harness.environment(), metrics: ui.metrics() }),
    preview: () => previewState(harness, ui),
    methods: () => METHOD_NAMES,
    call,
    runScenario: async (id, args) => {
      const scenario = findScenario(id);
      if (!scenario) {
        throw new Error(`harness: unknown scenario "${id}"`);
      }
      const scenarioArgs = isRecord(args) ? args : {};
      const start = isRecord(scenarioArgs['start'])
        ? parseStartOptions(scenarioArgs['start']).options
        : defaultStartOptions(harness.platform);
      return runScenario(harness, scenario, scenarioArgs, start);
    },
    scenarios: () => LAB_SCENARIOS.map((scenario) => scenario.id),
    imageBase64: (callId) => harness.imageBase64(callId),
    log: () => harness.log().slice(),
    clearLog: () => harness.clearLog(),
    setChromeHidden: (hidden) => ui.chromeHidden.set(hidden),
    setBackdrop: (color) => ui.backdrop.set(color),
    setPolling: (enabled) => harness.setPollingAllowed(enabled),
    setAutoStop: (enabled) => ui.setAutoStopAllowed(enabled),
    coverage: () => coverageSummary(harness),
    exportRecord: () => buildTestRecord(harness, ui),
    reset: () => harness.reset(),
  };
}

// ---------------------------------------------------------------- autorun

/**
 * `assets/harness-autorun.json` lets a host that cannot attach a debugger (the iOS simulator) drive
 * the harness: a smoke script overwrites the file inside the built app, and the app runs the listed
 * steps on launch, printing one JSON line per step to the console. The file shipped in the
 * repository has `enabled: false`, so a normal build does nothing.
 */
export type AutorunStep =
  | { call: string; args?: unknown }
  | { scenario: string; args?: unknown }
  | { wait: number }
  | { panel: string }
  | { chromeHidden: boolean };

export interface AutorunPlan {
  enabled: boolean;
  steps: AutorunStep[];
}

export const AUTORUN_URL = 'assets/harness-autorun.json';
export const AUTORUN_LINE = '[cph-autorun]';
export const AUTORUN_DONE = '[cph-autorun-done]';
export const AUTORUN_PART = '[cph-autorun-part]';
/** Capacitor's iOS logger cuts a console message at 4068 characters; stay well below that. */
export const AUTORUN_MAX_LINE = 3000;

let autorunMessageId = 0;

/**
 * Serialises one autorun message. A short message is `<marker> <json>`. A long one is split into
 * `[cph-autorun-part] <id> <index>/<count> <marker> <piece>` lines, which the host joins again.
 */
export function encodeAutorunMessage(marker: string, value: unknown, maxLength = AUTORUN_MAX_LINE): string[] {
  const json = JSON.stringify(value);
  if (json.length <= maxLength) {
    return [`${marker} ${json}`];
  }
  const id = ++autorunMessageId;
  const count = Math.ceil(json.length / maxLength);
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    const piece = json.slice(index * maxLength, (index + 1) * maxLength);
    lines.push(`${AUTORUN_PART} ${id} ${index + 1}/${count} ${marker} ${piece}`);
  }
  return lines;
}

export function parseAutorunPlan(input: unknown): AutorunPlan {
  if (!isRecord(input) || input['enabled'] !== true || !Array.isArray(input['steps'])) {
    return { enabled: false, steps: [] };
  }

  const steps: AutorunStep[] = [];
  for (const step of input['steps']) {
    if (!isRecord(step)) {
      continue;
    }
    if (typeof step['call'] === 'string') {
      steps.push({ call: step['call'], args: step['args'] });
    } else if (typeof step['scenario'] === 'string') {
      steps.push({ scenario: step['scenario'], args: step['args'] });
    } else if (typeof step['wait'] === 'number') {
      steps.push({ wait: Math.max(0, Math.min(60_000, step['wait'])) });
    } else if (typeof step['panel'] === 'string') {
      steps.push({ panel: step['panel'] });
    } else if (typeof step['chromeHidden'] === 'boolean') {
      steps.push({ chromeHidden: step['chromeHidden'] });
    }
  }
  return { enabled: steps.length > 0, steps };
}

export async function runAutorun(
  api: HarnessAutomationApi,
  ui: HarnessUiService,
  plan: AutorunPlan,
  emit: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  if (!plan.enabled) {
    return;
  }

  const send = (marker: string, value: unknown): void => encodeAutorunMessage(marker, value).forEach((line) => emit(line));

  api.setPolling(false);
  send(AUTORUN_LINE, { environment: api.environment() });

  for (const [index, step] of plan.steps.entries()) {
    try {
      if ('call' in step) {
        send(AUTORUN_LINE, { index, step: 'call', record: await api.call(step.call, step.args) });
      } else if ('scenario' in step) {
        send(AUTORUN_LINE, { index, step: 'scenario', result: await api.runScenario(step.scenario, step.args) });
      } else if ('wait' in step) {
        await new Promise((resolve) => setTimeout(resolve, step.wait));
        send(AUTORUN_LINE, { index, step: 'wait', ms: step.wait });
      } else if ('panel' in step) {
        const panel = PANELS.find((candidate) => candidate.id === step.panel);
        if (panel) {
          ui.panel.set(panel.id);
        }
        send(AUTORUN_LINE, { index, step: 'panel', panel: panel?.id ?? null });
      } else {
        api.setChromeHidden(step.chromeHidden);
        send(AUTORUN_LINE, { index, step: 'chromeHidden', hidden: step.chromeHidden });
      }
    } catch (error: unknown) {
      send(AUTORUN_LINE, { index, step: 'error', error: String(error) });
    }
  }

  send(AUTORUN_DONE, { steps: plan.steps.length, coverage: api.coverage() });
}

export async function loadAutorunPlan(url: string = AUTORUN_URL): Promise<AutorunPlan> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return response.ok ? parseAutorunPlan(await response.json()) : { enabled: false, steps: [] };
  } catch {
    return { enabled: false, steps: [] };
  }
}
