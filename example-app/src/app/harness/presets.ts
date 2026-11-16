import type { HarnessPlatform } from './capabilities';
import type { BooleanStartKey, NumberStartKey, StartOptionsForm, TextStartKey, TriBool } from './option-model';
import { BOOLEAN_START_KEYS, NUMBER_START_KEYS, TEXT_START_KEYS } from './option-model';

/**
 * Presets are functions of the measured viewport, never fixed pixel values, so the same preset
 * produces a sensible rectangle on a phone, a tablet and a desktop browser.
 *
 * A preset owns the geometry keys (it clears the ones it does not set) and may set a few behaviour
 * flags. Everything else in the form is left as the user had it, so camera, EXIF mode, output
 * destination, opacity and zoom combine freely with any preset.
 */

/** All values are CSS pixels, which equal Android dp and iOS points in a Capacitor WebView. */
export interface ViewportMetrics {
  width: number;
  height: number;
  /** Top safe-area inset (status bar, notch). */
  safeTop: number;
  /** Height of the control dock, including the bottom safe-area inset. */
  dockHeight: number;
  devicePixelRatio: number;
  platform: HarnessPlatform;
}

export interface PresetPatch {
  numbers: Partial<Record<NumberStartKey, number>>;
  booleans: Partial<Record<BooleanStartKey, TriBool>>;
  texts: Partial<Record<TextStartKey, string>>;
}

export type PresetId = 'fullscreen' | 'footer' | 'footer-default-exif' | 'tall' | 'wide' | 'square' | 'offset';

export interface Preset {
  id: PresetId;
  label: string;
  description: string;
  build(metrics: ViewportMetrics): PresetPatch;
}

/** Id of the element the web implementation appends its `<video>` to. */
export const WEB_PARENT_ID = 'cph-web-preview';

/** Smallest band, in CSS pixels, in which the harness controls remain usable. */
export const MIN_CONTROL_BAND = 220;

const GAP = 8;
/** Height the rectangle presets always leave free for the controls. */
const RESERVED_FOR_CONTROLS = 320;
const MIN_RECT_SIDE = 80;

/**
 * iOS divides `x` and `y` by the screen scale but uses `width`, `height` and `paddingBottom` as
 * points. To place the preview at a CSS position the origin therefore has to be multiplied back.
 */
function origin(value: number, metrics: ViewportMetrics): number {
  return metrics.platform === 'ios' ? Math.round(value * metrics.devicePixelRatio) : Math.round(value);
}

function rectangle(
  metrics: ViewportMetrics,
  x: number,
  y: number,
  width: number,
  height: number,
): Partial<Record<NumberStartKey, number>> {
  return {
    x: origin(x, metrics),
    y: origin(y, metrics),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function rectTop(metrics: ViewportMetrics): number {
  return metrics.safeTop + GAP;
}

/** Tallest rectangle that still leaves the controls a usable band underneath. */
function maxRectHeight(metrics: ViewportMetrics, extraTop = 0): number {
  return Math.max(MIN_RECT_SIDE, metrics.height - rectTop(metrics) - extraTop - RESERVED_FOR_CONTROLS);
}

const footerFlags = (exif: TriBool): Partial<Record<BooleanStartKey, TriBool>> => ({
  toBack: 'true',
  rotateWhenOrientationChanged: 'true',
  lockAndroidOrientation: 'false',
  disableAudio: 'true',
  disableExifHeaderStripping: exif,
});

export const PRESETS: readonly Preset[] = [
  {
    id: 'fullscreen',
    label: 'Full screen',
    description: 'No x, y, width or height. The preview sits behind the page (toBack: true).',
    build: () => ({ numbers: {}, booleans: { toBack: 'true' }, texts: {} }),
  },
  {
    id: 'footer',
    label: 'Footer, EXIF stripped',
    description:
      'Full screen with paddingBottom equal to the dock height and no height, orientation unlocked, ' +
      'disableExifHeaderStripping: false — the option set from the PR #339 framing report.',
    build: (metrics) => ({
      numbers: { paddingBottom: Math.round(metrics.dockHeight) },
      booleans: footerFlags('false'),
      texts: { position: 'rear' },
    }),
  },
  {
    id: 'footer-default-exif',
    label: 'Footer, EXIF default',
    description: 'The footer preset with disableExifHeaderStripping left unset, so the platform default applies.',
    build: (metrics) => ({
      numbers: { paddingBottom: Math.round(metrics.dockHeight) },
      booleans: footerFlags('unset'),
      texts: { position: 'rear' },
    }),
  },
  {
    id: 'tall',
    label: 'Tall rectangle',
    description: 'Half the width and up to twice as tall as wide, in front of the page (toBack: false).',
    build: (metrics) => {
      const width = 0.5 * metrics.width;
      const height = Math.min(maxRectHeight(metrics), 2 * width);
      return {
        numbers: rectangle(metrics, (metrics.width - width) / 2, rectTop(metrics), width, height),
        booleans: { toBack: 'false' },
        texts: {},
      };
    },
  },
  {
    id: 'wide',
    label: 'Wide rectangle',
    description: '90 % of the width and half as tall as wide, in front of the page.',
    build: (metrics) => {
      const width = 0.9 * metrics.width;
      const height = Math.min(maxRectHeight(metrics), width / 2);
      return {
        numbers: rectangle(metrics, (metrics.width - width) / 2, rectTop(metrics), width, height),
        booleans: { toBack: 'false' },
        texts: {},
      };
    },
  },
  {
    id: 'offset',
    label: 'Offset rectangle',
    description: 'Off-centre on both axes: a 3:2 rectangle 60 % wide, starting at 30 % of the width and pushed down.',
    build: (metrics) => {
      const extraTop = 40;
      const height = Math.min(maxRectHeight(metrics, extraTop), 0.4 * metrics.width);
      return {
        numbers: rectangle(metrics, 0.3 * metrics.width, rectTop(metrics) + extraTop, 0.6 * metrics.width, height),
        booleans: { toBack: 'false' },
        texts: {},
      };
    },
  },
  {
    id: 'square',
    label: 'Square',
    description: '60 % of the width. A square alone cannot reveal an aspect error, so use it last.',
    build: (metrics) => {
      const side = Math.min(maxRectHeight(metrics), 0.6 * metrics.width);
      return {
        numbers: rectangle(metrics, (metrics.width - side) / 2, rectTop(metrics), side, side),
        booleans: { toBack: 'false' },
        texts: {},
      };
    },
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Applies a preset to a copy of the form: geometry is replaced, other fields are merged. */
export function applyPreset(form: StartOptionsForm, preset: Preset, metrics: ViewportMetrics): StartOptionsForm {
  const patch = preset.build(metrics);
  const next: StartOptionsForm = {
    booleans: { ...form.booleans },
    numbers: { ...form.numbers },
    texts: { ...form.texts },
  };

  for (const key of NUMBER_START_KEYS) {
    const value = patch.numbers[key];
    next.numbers[key] = value === undefined ? { send: false, value: form.numbers[key].value } : { send: true, value };
  }
  for (const key of BOOLEAN_START_KEYS) {
    const value = patch.booleans[key];
    if (value !== undefined) {
      next.booleans[key] = value;
    }
  }
  for (const key of TEXT_START_KEYS) {
    const value = patch.texts[key];
    if (value !== undefined) {
      next.texts[key] = { send: true, value };
    }
  }

  // The web implementation needs a parent element and has no notion of a position on screen.
  if (metrics.platform === 'web') {
    next.texts.parent = { send: true, value: WEB_PARENT_ID };
    next.numbers.x = { send: false, value: next.numbers.x.value };
    next.numbers.y = { send: false, value: next.numbers.y.value };
  }

  return next;
}

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle the options ask for, in CSS pixels relative to the viewport, following the
 * documented contract: omitted width/height mean the full viewport, and `paddingBottom` shortens the
 * height. It is drawn as a guide so a native preview that disagrees with its options is visible at
 * a glance. Returns `null` on the web, where the preview is an element in the page.
 */
export function requestedRect(
  numbers: Partial<Record<NumberStartKey, number>>,
  metrics: ViewportMetrics,
): CssRect | null {
  if (metrics.platform === 'web') {
    return null;
  }

  const scale = metrics.platform === 'ios' ? metrics.devicePixelRatio : 1;
  const x = (numbers.x ?? 0) / scale;
  const y = (numbers.y ?? 0) / scale;
  const width = numbers.width !== undefined && numbers.width > 0 ? numbers.width : metrics.width;
  const fullHeight = numbers.height !== undefined && numbers.height > 0 ? numbers.height : metrics.height;
  const height = Math.max(0, fullHeight - (numbers.paddingBottom ?? 0));

  return { x, y, width, height };
}

export type ViewportOrientation = 'portrait' | 'landscape';

/** Orientation class of the viewport; a square one counts as portrait. */
export function viewportOrientation(size: { width: number; height: number }): ViewportOrientation {
  return size.width > size.height ? 'landscape' : 'portrait';
}

/**
 * Where the preview is expected after the viewport changed orientation while it was running. This
 * follows what each native layer does today, so the guide keeps describing the native view instead
 * of the rectangle of a viewport that no longer exists:
 *
 * - Android (`CameraActivity.onConfigurationChanged`): the container keeps its origin. Its width
 *   and height are exchanged when its own shape (portrait if taller than wide, otherwise landscape)
 *   differs from the new orientation. A wide rectangle started in portrait therefore stays as it
 *   is when the device turns to landscape, and is exchanged on the way back. The option
 *   `rotateWhenOrientationChanged` is not read on Android.
 * - iOS (`CameraPreviewPlugin.rotated`): computed from the values of `start()` every time. In
 *   landscape the origin is transposed and the longer side becomes the width; in portrait the
 *   origin is the original one and the longer side becomes the height. Nothing moves with
 *   `rotateWhenOrientationChanged: false`.
 *
 * `start` is the rectangle of `start()`; `current` is the rectangle before this change.
 */
export function rectAfterOrientationChange(
  platform: HarnessPlatform,
  rotateWhenOrientationChanged: boolean | undefined,
  start: CssRect,
  current: CssRect,
  orientation: ViewportOrientation,
): CssRect {
  if (platform === 'android') {
    const shape: ViewportOrientation = current.height > current.width ? 'portrait' : 'landscape';
    return shape === orientation
      ? current
      : { x: current.x, y: current.y, width: current.height, height: current.width };
  }

  if (platform === 'ios') {
    if (rotateWhenOrientationChanged === false) {
      return current;
    }
    const long = Math.max(start.width, start.height);
    const short = Math.min(start.width, start.height);
    return orientation === 'landscape'
      ? { x: start.y, y: start.x, width: long, height: short }
      : { x: start.x, y: start.y, width: short, height: long };
  }

  return current;
}

export interface ControlBand {
  top: number;
  height: number;
}

/**
 * With `toBack: false` the native view hides the page inside the preview rectangle, so the controls
 * must live entirely above or below it. Returns the larger free band, or `null` when neither is
 * large enough — the caller then arms an automatic stop so the user is never locked out.
 */
export function controlBand(rect: CssRect, metrics: ViewportMetrics): ControlBand | null {
  const above = Math.max(0, Math.min(rect.y, metrics.height));
  const belowTop = Math.max(0, Math.min(rect.y + rect.height, metrics.height));
  const below = metrics.height - belowTop;
  const band = below >= above ? { top: belowTop, height: below } : { top: 0, height: above };

  return band.height >= MIN_CONTROL_BAND ? band : null;
}
