/**
 * What each platform does with every public method and option, as observed in the plugin sources
 * and (for Android) on the emulator. This table drives three things: the platform labels in the UI,
 * the coverage checklist, and the classification of a rejection as "unsupported here (expected)"
 * rather than as a failure.
 *
 * It describes the plugin as it is today, including behaviour that contradicts the TypeScript
 * documentation. It is not a statement of what the plugin should do.
 */

export type HarnessPlatform = 'android' | 'ios' | 'web';

export type MethodName =
  | 'start'
  | 'stop'
  | 'isCameraStarted'
  | 'flip'
  | 'capture'
  | 'captureSample'
  | 'getSupportedFlashModes'
  | 'setFlashMode'
  | 'setOpacity'
  | 'startRecordVideo'
  | 'stopRecordVideo';

export const METHOD_NAMES: readonly MethodName[] = [
  'start',
  'stop',
  'isCameraStarted',
  'flip',
  'capture',
  'captureSample',
  'getSupportedFlashModes',
  'setFlashMode',
  'setOpacity',
  'startRecordVideo',
  'stopRecordVideo',
];

/** supported: works · partial: accepted but ignored or incomplete · unsupported: rejects or absent. */
export type SupportLevel = 'supported' | 'partial' | 'unsupported';

export interface PlatformSupport {
  level: SupportLevel;
  note?: string;
}

export type CoverageKind = 'method' | 'start-option' | 'call-option';

export interface CoverageItem {
  /** `method` for a method, `method.option` for an option. */
  id: string;
  kind: CoverageKind;
  label: string;
  /** Where in the app this item is exercised. */
  exercisedBy: string;
  /** True for keys the native code reads although the TypeScript declarations do not list them. */
  undeclared?: boolean;
  support: Record<HarnessPlatform, PlatformSupport>;
}

const yes = (note?: string): PlatformSupport => ({ level: 'supported', note });
const partial = (note: string): PlatformSupport => ({ level: 'partial', note });
const no = (note: string): PlatformSupport => ({ level: 'unsupported', note });

export const COVERAGE_ITEMS: readonly CoverageItem[] = [
  // Methods
  {
    id: 'start',
    kind: 'method',
    label: 'start()',
    exercisedBy: 'Configure → Start / Restart; presets',
    support: { android: yes(), ios: yes(), web: yes('needs `parent`; without it the call never settles') },
  },
  {
    id: 'stop',
    kind: 'method',
    label: 'stop()',
    exercisedBy: 'Dock → Stop; Reset; hardware back',
    support: { android: yes(), ios: yes(), web: yes('resolves even when nothing is running') },
  },
  {
    id: 'isCameraStarted',
    kind: 'method',
    label: 'isCameraStarted()',
    exercisedBy: 'Status strip poll; Live → Check now',
    support: { android: yes(), ios: yes(), web: no('rejects as unimplemented') },
  },
  {
    id: 'flip',
    kind: 'method',
    label: 'flip()',
    exercisedBy: 'Dock → Flip; Lab → rapid flip',
    support: { android: yes(), ios: yes(), web: no('throws "not supported under the web platform"') },
  },
  {
    id: 'capture',
    kind: 'method',
    label: 'capture()',
    exercisedBy: 'Dock → Capture; Live → Capture',
    support: { android: yes(), ios: yes(), web: yes('draws the video element to a canvas') },
  },
  {
    id: 'captureSample',
    kind: 'method',
    label: 'captureSample()',
    exercisedBy: 'Dock → Sample; Live → Sample, repeated sampling',
    support: { android: yes('always base64'), ios: yes(), web: partial('identical to capture()') },
  },
  {
    id: 'getSupportedFlashModes',
    kind: 'method',
    label: 'getSupportedFlashModes()',
    exercisedBy: 'Live → Flash → Query',
    support: { android: yes(), ios: yes(), web: no('throws "not supported under the web platform"') },
  },
  {
    id: 'setFlashMode',
    kind: 'method',
    label: 'setFlashMode()',
    exercisedBy: 'Live → Flash chips, including an unsupported value',
    support: { android: yes(), ios: yes(), web: no('throws "not supported under the web platform"') },
  },
  {
    id: 'setOpacity',
    kind: 'method',
    label: 'setOpacity()',
    exercisedBy: 'Live → Opacity → Apply',
    support: {
      android: partial('applies only with enableOpacity; the promise never settles'),
      ios: no('method is not registered'),
      web: yes('ignores opacity 0'),
    },
  },
  {
    id: 'startRecordVideo',
    kind: 'method',
    label: 'startRecordVideo()',
    exercisedBy: 'Live → Record → Start',
    support: {
      android: yes('resolves before recording has started'),
      ios: partial('recording is not implemented: with a preview running the call never settles and no file is written'),
      web: no('rejects as unimplemented'),
    },
  },
  {
    id: 'stopRecordVideo',
    kind: 'method',
    label: 'stopRecordVideo()',
    exercisedBy: 'Live → Record → Stop',
    support: {
      android: yes('resolves { videoFilePath }, which the declared return type omits'),
      ios: partial('never settles, and stops nothing: recording is not implemented'),
      web: no('rejects as unimplemented'),
    },
  },

  // start() options
  {
    id: 'start.parent',
    kind: 'start-option',
    label: 'parent',
    exercisedBy: 'Configure → Web',
    support: { android: partial('ignored'), ios: partial('ignored'), web: yes('required') },
  },
  {
    id: 'start.className',
    kind: 'start-option',
    label: 'className',
    exercisedBy: 'Configure → Web',
    support: { android: partial('ignored'), ios: partial('ignored'), web: yes() },
  },
  {
    id: 'start.x',
    kind: 'start-option',
    label: 'x',
    exercisedBy: 'Configure → Rectangle; tall, wide, square, offset presets',
    support: { android: yes('dp, integers only'), ios: partial('divided by the screen scale'), web: no('ignored') },
  },
  {
    id: 'start.y',
    kind: 'start-option',
    label: 'y',
    exercisedBy: 'Configure → Rectangle; tall, wide, square, offset presets',
    support: { android: yes('dp, integers only'), ios: partial('divided by the screen scale'), web: no('ignored') },
  },
  {
    id: 'start.width',
    kind: 'start-option',
    label: 'width',
    exercisedBy: 'Configure → Rectangle; rectangle presets',
    support: { android: yes('dp, integers only'), ios: yes('points'), web: partial('ideal video width only') },
  },
  {
    id: 'start.height',
    kind: 'start-option',
    label: 'height',
    exercisedBy: 'Configure → Rectangle; rectangle presets',
    support: { android: yes('dp, integers only'), ios: yes('points'), web: partial('ideal video height only') },
  },
  {
    id: 'start.paddingBottom',
    kind: 'start-option',
    label: 'paddingBottom',
    exercisedBy: 'Configure → Rectangle; footer presets',
    support: {
      android: partial('applied only when height is also sent'),
      ios: yes(),
      web: no('ignored'),
    },
  },
  {
    id: 'start.toBack',
    kind: 'start-option',
    label: 'toBack',
    exercisedBy: 'Configure → Behaviour; the control band proves both modes',
    support: { android: yes(), ios: yes(), web: no('ignored') },
  },
  {
    id: 'start.position',
    kind: 'start-option',
    label: 'position',
    exercisedBy: 'Configure → Camera; "unset" shows the real default',
    support: {
      android: yes('omitted means rear, although the typings say front'),
      ios: yes('omitted means rear, although the typings say front'),
      web: yes('anything but "rear" is treated as front'),
    },
  },
  {
    id: 'start.rotateWhenOrientationChanged',
    kind: 'start-option',
    label: 'rotateWhenOrientationChanged',
    exercisedBy: 'Configure → Behaviour; rotate the device',
    support: { android: partial('ignored'), ios: yes(), web: no('ignored') },
  },
  {
    id: 'start.lockAndroidOrientation',
    kind: 'start-option',
    label: 'lockAndroidOrientation',
    exercisedBy: 'Configure → Behaviour; rotate the device',
    support: { android: yes(), ios: no('ignored'), web: no('ignored') },
  },
  {
    id: 'start.storeToFile',
    kind: 'start-option',
    label: 'storeToFile',
    exercisedBy: 'Configure → Output; Results shows the path and the WebView URL',
    support: { android: partial('capture() only; samples stay base64'), ios: yes(), web: no('ignored') },
  },
  {
    id: 'start.disableExifHeaderStripping',
    kind: 'start-option',
    label: 'disableExifHeaderStripping',
    exercisedBy: 'Configure → Output; Results shows encoded size and raw EXIF',
    support: {
      android: yes('omitted means true, although the typings say false'),
      ios: partial('ignored'),
      web: no('ignored'),
    },
  },
  {
    id: 'start.enableHighResolution',
    kind: 'start-option',
    label: 'enableHighResolution',
    exercisedBy: 'Configure → Output',
    support: { android: partial('ignored'), ios: yes(), web: no('ignored') },
  },
  {
    id: 'start.disableAudio',
    kind: 'start-option',
    label: 'disableAudio',
    exercisedBy: 'Configure → Behaviour; record with and without audio',
    support: {
      android: partial('ignored; recording always opens the microphone'),
      ios: yes(),
      web: yes('omitting it asks for the microphone'),
    },
  },
  {
    id: 'start.enableOpacity',
    kind: 'start-option',
    label: 'enableOpacity',
    exercisedBy: 'Configure → Behaviour; then Live → Opacity',
    support: { android: yes(), ios: no('ignored'), web: partial('opacity works without it') },
  },
  {
    id: 'start.enableZoom',
    kind: 'start-option',
    label: 'enableZoom',
    exercisedBy: 'Configure → Behaviour; pinch inside the preview, tap to focus',
    support: { android: yes(), ios: yes(), web: no('ignored') },
  },

  // Options of the other calls
  {
    id: 'capture.quality',
    kind: 'call-option',
    label: 'capture: quality',
    exercisedBy: 'Live → Capture',
    support: { android: yes(), ios: yes(), web: partial('omitted switches the output to PNG') },
  },
  {
    id: 'capture.width',
    kind: 'call-option',
    label: 'capture: width',
    exercisedBy: 'Live → Capture',
    support: { android: yes('selects a sensor picture size'), ios: partial('ignored'), web: partial('ignored') },
  },
  {
    id: 'capture.height',
    kind: 'call-option',
    label: 'capture: height',
    exercisedBy: 'Live → Capture',
    support: { android: yes('selects a sensor picture size'), ios: partial('ignored'), web: partial('ignored') },
  },
  {
    id: 'captureSample.quality',
    kind: 'call-option',
    label: 'captureSample: quality',
    exercisedBy: 'Live → Sample',
    support: { android: yes(), ios: yes(), web: partial('omitted switches the output to PNG') },
  },
  {
    id: 'setOpacity.opacity',
    kind: 'call-option',
    label: 'setOpacity: opacity',
    exercisedBy: 'Live → Opacity slider, including 0 and 1',
    support: { android: yes('needs enableOpacity'), ios: no('method is not registered'), web: partial('ignores 0') },
  },
  {
    id: 'setFlashMode.flashMode',
    kind: 'call-option',
    label: 'setFlashMode: flashMode',
    exercisedBy: 'Live → Flash chips',
    support: { android: yes(), ios: yes(), web: no('method throws') },
  },
  {
    id: 'startRecordVideo.position',
    kind: 'call-option',
    label: 'startRecordVideo: position',
    exercisedBy: 'Live → Record',
    support: { android: partial('read, then ignored'), ios: no('ignored'), web: no('method rejects') },
  },
  {
    id: 'startRecordVideo.width',
    kind: 'call-option',
    label: 'startRecordVideo: width',
    exercisedBy: 'Live → Record',
    support: { android: partial('read, then ignored'), ios: no('ignored'), web: no('method rejects') },
  },
  {
    id: 'startRecordVideo.height',
    kind: 'call-option',
    label: 'startRecordVideo: height',
    exercisedBy: 'Live → Record',
    support: { android: partial('read, then ignored'), ios: no('ignored'), web: no('method rejects') },
  },
  {
    id: 'startRecordVideo.withFlash',
    kind: 'call-option',
    label: 'startRecordVideo: withFlash',
    exercisedBy: 'Live → Record',
    undeclared: true,
    support: { android: yes(), ios: no('ignored'), web: no('method rejects') },
  },
  {
    id: 'startRecordVideo.maxDuration',
    kind: 'call-option',
    label: 'startRecordVideo: maxDuration',
    exercisedBy: 'Live → Record',
    undeclared: true,
    support: { android: yes('milliseconds'), ios: no('ignored'), web: no('method rejects') },
  },
];

const ITEMS_BY_ID = new Map(COVERAGE_ITEMS.map((item) => [item.id, item]));

export function coverageItem(id: string): CoverageItem | undefined {
  return ITEMS_BY_ID.get(id);
}

export function supportFor(id: string, platform: HarnessPlatform): PlatformSupport {
  return ITEMS_BY_ID.get(id)?.support[platform] ?? { level: 'supported' };
}

/** A rejection from a method the platform does not implement is expected, not a failure. */
export function isExpectedUnsupported(method: MethodName, platform: HarnessPlatform): boolean {
  return supportFor(method, platform).level === 'unsupported';
}

export function supportSymbol(level: SupportLevel): string {
  switch (level) {
    case 'supported':
      return '✓';
    case 'partial':
      return '◐';
    default:
      return '✗';
  }
}

/**
 * Coverage ids exercised by one call: the method itself plus one id per option key that was
 * actually sent. Keys the table does not know are ignored.
 */
export function coverageIdsForCall(method: MethodName, args: unknown): string[] {
  const ids: string[] = [method];
  if (typeof args === 'object' && args !== null) {
    for (const key of Object.keys(args)) {
      const id = `${method}.${key}`;
      if (ITEMS_BY_ID.has(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

export function normalizePlatform(platform: string): HarnessPlatform {
  return platform === 'android' || platform === 'ios' ? platform : 'web';
}
