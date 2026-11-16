import type {
  CameraOpacityOptions,
  CameraPreviewOptions,
  CameraPreviewPictureOptions,
  CameraSampleOptions,
} from '@capacitor-community/camera-preview';

/**
 * Form model for every argument the plugin accepts.
 *
 * Omitting an option and passing its default value are different inputs for this plugin (several
 * documented defaults differ from the runtime ones), so every control has an explicit "unset" state
 * and the builders below emit a key only when the user chose to send it.
 */

/** A boolean option with an explicit "do not send" state. */
export type TriBool = 'unset' | 'true' | 'false';

/** A numeric option: `send` decides whether the key is emitted; `value` survives while unset. */
export interface NumberField {
  send: boolean;
  value: number | null;
}

/** A string option with the same send/keep semantics as {@link NumberField}. */
export interface TextField {
  send: boolean;
  value: string;
}

export const BOOLEAN_START_KEYS = [
  'toBack',
  'storeToFile',
  'disableExifHeaderStripping',
  'lockAndroidOrientation',
  'rotateWhenOrientationChanged',
  'enableOpacity',
  'enableZoom',
  'disableAudio',
  'enableHighResolution',
] as const;
export const NUMBER_START_KEYS = ['x', 'y', 'width', 'height', 'paddingBottom'] as const;
export const TEXT_START_KEYS = ['position', 'parent', 'className'] as const;

export type BooleanStartKey = (typeof BOOLEAN_START_KEYS)[number];
export type NumberStartKey = (typeof NUMBER_START_KEYS)[number];
export type TextStartKey = (typeof TEXT_START_KEYS)[number];
export type StartOptionKey = BooleanStartKey | NumberStartKey | TextStartKey;

/** Every key of `CameraPreviewOptions`; a compile error here means the plugin gained an option. */
export const START_OPTION_KEYS: readonly StartOptionKey[] = [
  ...TEXT_START_KEYS,
  ...NUMBER_START_KEYS,
  ...BOOLEAN_START_KEYS,
];
type MissingStartKeys = Exclude<keyof CameraPreviewOptions, StartOptionKey>;
// If the plugin adds an option, this assignment stops compiling until the form covers it.
export const ALL_START_KEYS_COVERED: MissingStartKeys extends never ? true : never = true;

export interface StartOptionsForm {
  booleans: Record<BooleanStartKey, TriBool>;
  numbers: Record<NumberStartKey, NumberField>;
  texts: Record<TextStartKey, TextField>;
}

export interface CaptureForm {
  quality: NumberField;
  width: NumberField;
  height: NumberField;
}

export interface SampleForm {
  quality: NumberField;
}

export interface OpacityForm {
  opacity: NumberField;
}

/**
 * `startRecordVideo()` is declared as taking `CameraPreviewOptions`, but the Android implementation
 * also reads two undeclared keys. They are typed here instead of being smuggled through a cast.
 */
export type RecordVideoOptions = CameraPreviewOptions & {
  withFlash?: boolean;
  maxDuration?: number;
};

export interface RecordForm {
  position: TextField;
  width: NumberField;
  height: NumberField;
  maxDuration: NumberField;
  withFlash: TriBool;
}

const unsetNumber = (value: number | null = null): NumberField => ({ send: false, value });
const unsetText = (value = ''): TextField => ({ send: false, value });

export function emptyStartForm(): StartOptionsForm {
  return {
    booleans: {
      toBack: 'unset',
      storeToFile: 'unset',
      disableExifHeaderStripping: 'unset',
      lockAndroidOrientation: 'unset',
      rotateWhenOrientationChanged: 'unset',
      enableOpacity: 'unset',
      enableZoom: 'unset',
      disableAudio: 'unset',
      enableHighResolution: 'unset',
    },
    numbers: {
      x: unsetNumber(),
      y: unsetNumber(),
      width: unsetNumber(),
      height: unsetNumber(),
      paddingBottom: unsetNumber(),
    },
    texts: {
      position: unsetText('rear'),
      parent: unsetText(),
      className: unsetText(),
    },
  };
}

export function emptyCaptureForm(): CaptureForm {
  return { quality: { send: true, value: 85 }, width: unsetNumber(), height: unsetNumber() };
}

export function emptySampleForm(): SampleForm {
  return { quality: { send: true, value: 85 } };
}

export function emptyOpacityForm(): OpacityForm {
  return { opacity: { send: true, value: 0.5 } };
}

export function emptyRecordForm(): RecordForm {
  return {
    position: unsetText('rear'),
    width: unsetNumber(),
    height: unsetNumber(),
    maxDuration: unsetNumber(),
    withFlash: 'unset',
  };
}

function numberToSend(field: NumberField): number | undefined {
  return field.send && field.value !== null && Number.isFinite(field.value) ? field.value : undefined;
}

function textToSend(field: TextField): string | undefined {
  return field.send ? field.value : undefined;
}

function boolToSend(value: TriBool): boolean | undefined {
  return value === 'unset' ? undefined : value === 'true';
}

/** Builds exactly the object passed to `start()`: unset keys are absent, not `undefined`. */
export function buildStartOptions(form: StartOptionsForm): CameraPreviewOptions {
  const options: CameraPreviewOptions = {};

  for (const key of TEXT_START_KEYS) {
    const value = textToSend(form.texts[key]);
    if (value !== undefined) {
      options[key] = value;
    }
  }
  for (const key of NUMBER_START_KEYS) {
    const value = numberToSend(form.numbers[key]);
    if (value !== undefined) {
      options[key] = value;
    }
  }
  for (const key of BOOLEAN_START_KEYS) {
    const value = boolToSend(form.booleans[key]);
    if (value !== undefined) {
      options[key] = value;
    }
  }

  return options;
}

/** The inverse of {@link buildStartOptions}; used by presets and by pasted option objects. */
export function startFormFromOptions(options: CameraPreviewOptions): StartOptionsForm {
  const form = emptyStartForm();

  for (const key of TEXT_START_KEYS) {
    const value = options[key];
    if (typeof value === 'string') {
      form.texts[key] = { send: true, value };
    }
  }
  for (const key of NUMBER_START_KEYS) {
    const value = options[key];
    if (typeof value === 'number') {
      form.numbers[key] = { send: true, value };
    }
  }
  for (const key of BOOLEAN_START_KEYS) {
    const value = options[key];
    if (typeof value === 'boolean') {
      form.booleans[key] = value ? 'true' : 'false';
    }
  }

  return form;
}

export function buildCaptureOptions(form: CaptureForm): CameraPreviewPictureOptions {
  const options: CameraPreviewPictureOptions = {};
  const quality = numberToSend(form.quality);
  const width = numberToSend(form.width);
  const height = numberToSend(form.height);

  if (quality !== undefined) {
    options.quality = quality;
  }
  if (width !== undefined) {
    options.width = width;
  }
  if (height !== undefined) {
    options.height = height;
  }

  return options;
}

export function buildSampleOptions(form: SampleForm): CameraSampleOptions {
  const quality = numberToSend(form.quality);
  return quality === undefined ? {} : { quality };
}

export function buildOpacityOptions(form: OpacityForm): CameraOpacityOptions {
  const opacity = numberToSend(form.opacity);
  return opacity === undefined ? {} : { opacity };
}

export function buildRecordOptions(form: RecordForm): RecordVideoOptions {
  const options: RecordVideoOptions = {};
  const position = textToSend(form.position);
  const width = numberToSend(form.width);
  const height = numberToSend(form.height);
  const maxDuration = numberToSend(form.maxDuration);
  const withFlash = boolToSend(form.withFlash);

  if (position !== undefined) {
    options.position = position;
  }
  if (width !== undefined) {
    options.width = width;
  }
  if (height !== undefined) {
    options.height = height;
  }
  if (maxDuration !== undefined) {
    options.maxDuration = maxDuration;
  }
  if (withFlash !== undefined) {
    options.withFlash = withFlash;
  }

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows an untyped object (automation arguments, pasted JSON) to start options. Keys with a value
 * of the wrong primitive type are dropped and reported, never coerced.
 */
export function parseStartOptions(input: unknown): { options: CameraPreviewOptions; dropped: string[] } {
  const options: CameraPreviewOptions = {};
  const dropped: string[] = [];

  if (!isRecord(input)) {
    return { options, dropped };
  }

  const known = new Set<string>(START_OPTION_KEYS);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      dropped.push(key);
    }
  }
  for (const key of TEXT_START_KEYS) {
    const value = input[key];
    if (typeof value === 'string') {
      options[key] = value;
    } else if (value !== undefined) {
      dropped.push(key);
    }
  }
  for (const key of NUMBER_START_KEYS) {
    const value = input[key];
    if (typeof value === 'number') {
      options[key] = value;
    } else if (value !== undefined) {
      dropped.push(key);
    }
  }
  for (const key of BOOLEAN_START_KEYS) {
    const value = input[key];
    if (typeof value === 'boolean') {
      options[key] = value;
    } else if (value !== undefined) {
      dropped.push(key);
    }
  }

  return { options, dropped };
}

export function parsePictureOptions(input: unknown): CameraPreviewPictureOptions {
  const options: CameraPreviewPictureOptions = {};
  if (!isRecord(input)) {
    return options;
  }
  for (const key of ['quality', 'width', 'height'] as const) {
    const value = input[key];
    if (typeof value === 'number') {
      options[key] = value;
    }
  }
  return options;
}

export function parseSampleOptions(input: unknown): CameraSampleOptions {
  const { quality } = parsePictureOptions(input);
  return quality === undefined ? {} : { quality };
}

export function parseOpacityOptions(input: unknown): CameraOpacityOptions {
  if (isRecord(input) && typeof input['opacity'] === 'number') {
    return { opacity: input['opacity'] };
  }
  return {};
}

export function parseFlashOptions(input: unknown): { flashMode: string } {
  if (isRecord(input) && typeof input['flashMode'] === 'string') {
    return { flashMode: input['flashMode'] };
  }
  return { flashMode: '' };
}

export function parseRecordOptions(input: unknown): RecordVideoOptions {
  const { options } = parseStartOptions(input);
  const record: RecordVideoOptions = { ...options };
  if (isRecord(input)) {
    if (typeof input['withFlash'] === 'boolean') {
      record.withFlash = input['withFlash'];
    }
    if (typeof input['maxDuration'] === 'number') {
      record.maxDuration = input['maxDuration'];
    }
  }
  return record;
}
