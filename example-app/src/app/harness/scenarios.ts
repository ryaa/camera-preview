import type { CameraPreviewOptions } from '@capacitor-community/camera-preview';

import type { CallOutcome, CallResult, CameraHarnessService } from './camera-harness.service';
import type { HarnessPlatform, MethodName } from './capabilities';
import { WEB_PARENT_ID } from './presets';

/**
 * Deliberate concurrency scenarios. The normal controls prevent accidental double submission; these
 * do the opposite on purpose: they issue calls in the same tick and report how each one settled.
 *
 * The same code runs from the Lab panel and from the automation entry point, so a manual run and an
 * automated run are comparable call for call. The recorded Camera1 outcomes are the oracle a
 * replacement backend has to reproduce.
 */

export interface LabCallSummary {
  label: string;
  method: MethodName;
  outcome: CallOutcome;
  durationMs: number;
  error?: string;
  /** Keys of the resolved value; payloads are never included. */
  resultKeys?: string[];
  expectedUnsupported?: boolean;
}

export interface LabGroup {
  name: string;
  /** Milliseconds since the scenario started. */
  atMs: number;
  calls: LabCallSummary[];
}

export interface LabResult {
  scenario: string;
  label: string;
  startOptions: CameraPreviewOptions;
  groups: LabGroup[];
  /** Named observations made between groups, e.g. the readiness after a race. */
  checks: Record<string, unknown>;
  /** Number of calls that did not settle within their deadline. */
  unsettled: number;
  durationMs: number;
}

export interface LabScenario {
  id: string;
  label: string;
  /** What the scenario issues, shown on its button. */
  issues: string;
  run(context: LabContext): Promise<void>;
}

type LabCall = readonly [label: string, call: Promise<CallResult<unknown>>];

export interface LabContext {
  readonly harness: CameraHarnessService;
  readonly startOptions: CameraPreviewOptions;
  readonly args: Readonly<Record<string, unknown>>;
  /** Awaits calls that were all issued before this function was entered. */
  group(name: string, calls: readonly LabCall[]): Promise<LabCallSummary[]>;
  check(name: string, value: unknown): void;
  /** Readiness as the plugin reports it; `'unsupported'` where the method does not exist. */
  started(): Promise<boolean | 'unsupported' | 'rejected'>;
  ensureStopped(): Promise<void>;
  ensureStarted(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function defaultStartOptions(platform: HarnessPlatform): CameraPreviewOptions {
  return platform === 'web'
    ? { position: 'rear', parent: WEB_PARENT_ID, disableAudio: true }
    : { position: 'rear', toBack: true };
}

const CAPTURE = { quality: 85 } as const;

export const LAB_SCENARIOS: readonly LabScenario[] = [
  {
    id: 'duplicate-start',
    label: 'Duplicate start',
    issues: 'two start() in one tick',
    run: async (lab) => {
      await lab.ensureStopped();
      const h = lab.harness;
      await lab.group('duplicate-start', [
        ['start#1', h.start(lab.startOptions)],
        ['start#2', h.start(lab.startOptions)],
      ]);
      lab.check('isCameraStarted', await lab.started());
    },
  },
  {
    id: 'start-stop-race',
    label: 'Start–stop race',
    issues: 'start() and stop() in one tick',
    run: async (lab) => {
      await lab.ensureStopped();
      const h = lab.harness;
      await lab.group('stop-during-start', [
        ['start', h.start(lab.startOptions)],
        ['stop', h.stop()],
      ]);
      lab.check('isCameraStarted', await lab.started());
    },
  },
  {
    id: 'overlapping-capture',
    label: 'Overlapping captures',
    issues: 'two capture() in one tick',
    run: async (lab) => {
      await lab.ensureStarted();
      const h = lab.harness;
      await lab.group('overlapping-capture', [
        ['capture#1', h.capture(CAPTURE)],
        ['capture#2', h.capture(CAPTURE)],
      ]);
    },
  },
  {
    id: 'overlapping-sample',
    label: 'Overlapping samples',
    issues: 'two captureSample() in one tick',
    run: async (lab) => {
      await lab.ensureStarted();
      const h = lab.harness;
      await lab.group('overlapping-sample', [
        ['sample#1', h.captureSample(CAPTURE)],
        ['sample#2', h.captureSample(CAPTURE)],
      ]);
    },
  },
  {
    id: 'capture-with-sample',
    label: 'Capture with sample',
    issues: 'capture() and captureSample() in one tick',
    run: async (lab) => {
      await lab.ensureStarted();
      const h = lab.harness;
      await lab.group('capture-with-sample', [
        ['capture', h.capture(CAPTURE)],
        ['sample', h.captureSample(CAPTURE)],
      ]);
    },
  },
  {
    id: 'rapid-flip',
    label: 'Rapid flip',
    issues: 'three flip() in one tick, then flip() with capture()',
    run: async (lab) => {
      await lab.ensureStarted();
      const h = lab.harness;
      await lab.group('rapid-flip', [
        ['flip#1', h.flip()],
        ['flip#2', h.flip()],
        ['flip#3', h.flip()],
      ]);
      lab.check('isCameraStarted:afterRapidFlip', await lab.started());
      await lab.group('flip-then-capture', [
        ['flip', h.flip()],
        ['capture', h.capture(CAPTURE)],
      ]);
    },
  },
  {
    id: 'stop-during-capture',
    label: 'Stop during capture',
    issues: 'capture() then stop() in one tick',
    run: async (lab) => {
      await lab.ensureStarted();
      await lab.sleep(300);
      const h = lab.harness;
      await lab.group('stop-during-capture', [
        ['capture', h.capture(CAPTURE)],
        ['stop', h.stop()],
      ]);
      lab.check('isCameraStarted', await lab.started());
    },
  },
  {
    id: 'start-stop-cycles',
    label: 'Start/stop cycles',
    issues: 'N sequential start()/stop() pairs (default 5)',
    run: async (lab) => {
      await lab.ensureStopped();
      const h = lab.harness;
      const requested = lab.args['cycles'];
      const cycles = typeof requested === 'number' && requested > 0 ? Math.min(50, Math.floor(requested)) : 5;
      const readiness: unknown[] = [];
      for (let index = 0; index < cycles; index++) {
        await lab.group(`cycle[${index}]:start`, [['start', h.start(lab.startOptions)]]);
        readiness.push(await lab.started());
        await lab.group(`cycle[${index}]:stop`, [['stop', h.stop()]]);
      }
      lab.check('readyAfterEachStart', readiness);
    },
  },
  {
    id: 'no-session',
    label: 'No session',
    issues: 'every method with nothing running',
    run: async (lab) => {
      await lab.ensureStopped();
      const h = lab.harness;
      await lab.group('not-running', [
        ['capture', h.capture(CAPTURE)],
        ['sample', h.captureSample(CAPTURE)],
        ['flip', h.flip()],
        ['getSupportedFlashModes', h.getSupportedFlashModes()],
        ['setFlashMode', h.setFlashMode({ flashMode: 'off' })],
        ['setOpacity', h.setOpacity({ opacity: 0.5 })],
        ['startRecordVideo', h.startRecordVideo({})],
        ['stopRecordVideo', h.stopRecordVideo()],
        ['stop', h.stop()],
        ['isCameraStarted', h.isCameraStarted()],
      ]);
    },
  },
  {
    id: 'recording-interruptions',
    label: 'Recording interruptions',
    issues: 'a second startRecordVideo(), flip() and stop() during a recording',
    run: async (lab) => {
      await lab.ensureStarted();
      const h = lab.harness;
      await lab.group('record:start', [['startRecordVideo', h.startRecordVideo({})]]);
      await lab.sleep(1000);
      await lab.group('record:second-start', [['startRecordVideo#2', h.startRecordVideo({})]]);
      await lab.group('record:flip', [['flip', h.flip()]]);
      await lab.group('record:stop-preview', [['stop', h.stop()]]);
      await lab.group('record:stop-after-preview-stop', [['stopRecordVideo', h.stopRecordVideo()]]);
      lab.check('isCameraStarted', await lab.started());
    },
  },
  {
    id: 'fractional-option',
    label: 'Fractional option',
    issues: 'start() with width: 200.5 — compare the preview with the guide',
    run: async (lab) => {
      await lab.ensureStopped();
      const h = lab.harness;
      const options: CameraPreviewOptions = { ...lab.startOptions, x: 20, y: 60, width: 200.5, height: 300 };
      await lab.group('fractional-start', [['start', h.start(options)]]);
      lab.check('isCameraStarted', await lab.started());
      lab.check('requestedRect', h.previewRect());
    },
  },
];

export function findScenario(id: string): LabScenario | undefined {
  return LAB_SCENARIOS.find((scenario) => scenario.id === id);
}

function summarize(label: string, result: CallResult<unknown>): LabCallSummary {
  const { record } = result;
  const summary: LabCallSummary = {
    label,
    method: record.method,
    outcome: record.outcome,
    durationMs: record.durationMs,
  };
  if (record.error !== undefined) {
    summary.error = record.error;
  }
  if (record.expectedUnsupported) {
    summary.expectedUnsupported = true;
  }
  if (typeof result.value === 'object' && result.value !== null) {
    summary.resultKeys = Object.keys(result.value);
  }
  return summary;
}

export async function runScenario(
  harness: CameraHarnessService,
  scenario: LabScenario,
  args: Readonly<Record<string, unknown>> = {},
  startOptions: CameraPreviewOptions = defaultStartOptions(harness.platform),
): Promise<LabResult> {
  const t0 = performance.now();
  const result: LabResult = {
    scenario: scenario.id,
    label: scenario.label,
    startOptions,
    groups: [],
    checks: {},
    unsettled: 0,
    durationMs: 0,
  };

  const started: LabContext['started'] = async () => {
    const { record, value } = await harness.isCameraStarted();
    if (record.outcome === 'resolved' && value) {
      return value.value;
    }
    return record.expectedUnsupported ? 'unsupported' : 'rejected';
  };

  const context: LabContext = {
    harness,
    startOptions,
    args,
    started,
    group: async (name, calls) => {
      const atMs = Math.round(performance.now() - t0);
      const settled = await Promise.all(calls.map(async ([label, call]) => summarize(label, await call)));
      result.groups.push({ name, atMs, calls: settled });
      result.unsettled += settled.filter((call) => call.outcome === 'unsettled').length;
      return settled;
    },
    check: (name, value) => {
      result.checks[name] = value;
    },
    ensureStopped: async () => {
      // "camera already stopped" is the expected answer when nothing was running.
      await harness.stop();
    },
    ensureStarted: async () => {
      const state = await started();
      const running = state === 'unsupported' ? harness.session() === 'running' : state === true;
      if (!running) {
        await harness.stop();
        await harness.start(startOptions);
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  harness.note(`lab scenario "${scenario.id}" started`);
  await scenario.run(context);
  result.durationMs = Math.round(performance.now() - t0);
  harness.note(`lab scenario "${scenario.id}" finished: ${result.unsettled} unsettled`);

  return result;
}
