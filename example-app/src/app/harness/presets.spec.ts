import type { HarnessPlatform } from './capabilities';
import { buildStartOptions, emptyStartForm } from './option-model';
import {
  MIN_CONTROL_BAND,
  PRESETS,
  WEB_PARENT_ID,
  applyPreset,
  controlBand,
  findPreset,
  rectAfterOrientationChange,
  requestedRect,
  viewportOrientation,
} from './presets';
import type { Preset, ViewportMetrics } from './presets';

function metrics(
  width: number,
  height: number,
  platform: HarnessPlatform = 'android',
  devicePixelRatio = 2.75,
): ViewportMetrics {
  return { width, height, safeTop: 24, dockHeight: 64, devicePixelRatio, platform };
}

function preset(id: string): Preset {
  const found = findPreset(id);
  if (!found) {
    throw new Error(`no preset ${id}`);
  }
  return found;
}

const VIEWPORTS: [string, ViewportMetrics][] = [
  ['small phone', metrics(360, 640)],
  ['phone', metrics(393, 851)],
  ['tall phone', metrics(412, 915)],
  ['tablet', metrics(820, 1180)],
  ['phone landscape', metrics(851, 393)],
];
const RECTANGLE_PRESETS = ['tall', 'wide', 'offset', 'square'];

describe('presets', () => {
  it('has unique ids', () => {
    expect(new Set(PRESETS.map((item) => item.id)).size).toBe(PRESETS.length);
  });

  it('produces integer geometry on every viewport', () => {
    for (const [name, viewport] of VIEWPORTS) {
      for (const item of PRESETS) {
        for (const [key, value] of Object.entries(item.build(viewport).numbers)) {
          expect(Number.isInteger(value)).withContext(`${item.id}.${key} on ${name}`).toBeTrue();
        }
      }
    }
  });

  it('keeps rectangle presets inside the viewport', () => {
    for (const [name, viewport] of VIEWPORTS) {
      for (const id of RECTANGLE_PRESETS) {
        const rect = requestedRect(preset(id).build(viewport).numbers, viewport);
        expect(rect).withContext(`${id} on ${name}`).not.toBeNull();
        if (rect) {
          expect(rect.x).withContext(`${id} on ${name}`).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).withContext(`${id} on ${name}`).toBeLessThanOrEqual(viewport.width);
          expect(rect.y + rect.height).withContext(`${id} on ${name}`).toBeLessThanOrEqual(viewport.height);
        }
      }
    }
  });

  it('leaves a usable control band next to every rectangle preset on portrait screens', () => {
    for (const [name, viewport] of VIEWPORTS.filter(([, item]) => item.height > item.width)) {
      for (const id of RECTANGLE_PRESETS) {
        const rect = requestedRect(preset(id).build(viewport).numbers, viewport);
        const band = rect ? controlBand(rect, viewport) : null;
        expect(band).withContext(`${id} on ${name}`).not.toBeNull();
        expect(band?.height ?? 0)
          .withContext(`${id} on ${name}`)
          .toBeGreaterThanOrEqual(MIN_CONTROL_BAND);
      }
    }
  });

  it('gives the tall, wide and offset presets clearly non-square aspects', () => {
    const viewport = metrics(393, 851);
    const aspectOf = (id: string): number => {
      const rect = requestedRect(preset(id).build(viewport).numbers, viewport);
      return rect ? rect.width / rect.height : 1;
    };

    expect(aspectOf('tall')).toBeLessThan(0.7);
    expect(aspectOf('wide')).toBeGreaterThan(1.8);
    expect(Math.abs(aspectOf('offset') - 1)).toBeGreaterThan(0.05);
    expect(aspectOf('square')).toBe(1);
  });

  it('builds the footer preset from the measured dock height, with no height', () => {
    const viewport = metrics(393, 851);
    const options = buildStartOptions(applyPreset(emptyStartForm(), preset('footer'), viewport));

    expect(options).toEqual({
      position: 'rear',
      paddingBottom: 64,
      toBack: true,
      rotateWhenOrientationChanged: true,
      lockAndroidOrientation: false,
      disableAudio: true,
      disableExifHeaderStripping: false,
    });
  });

  it('leaves disableExifHeaderStripping unset in the second footer preset', () => {
    const form = emptyStartForm();
    form.booleans.disableExifHeaderStripping = 'true';
    const options = buildStartOptions(applyPreset(form, preset('footer-default-exif'), metrics(393, 851)));

    expect('disableExifHeaderStripping' in options).toBeFalse();
    expect(options.paddingBottom).toBe(64);
  });

  describe('applyPreset', () => {
    it('replaces geometry but keeps unrelated choices', () => {
      const form = emptyStartForm();
      form.numbers.x = { send: true, value: 5 };
      form.numbers.paddingBottom = { send: true, value: 99 };
      form.booleans.storeToFile = 'true';
      form.texts.position = { send: true, value: 'front' };

      const options = buildStartOptions(applyPreset(form, preset('fullscreen'), metrics(393, 851)));

      expect(options).toEqual({ position: 'front', toBack: true, storeToFile: true });
    });

    it('does not modify the form it was given', () => {
      const form = emptyStartForm();
      applyPreset(form, preset('square'), metrics(393, 851));

      expect(form).toEqual(emptyStartForm());
    });

    it('multiplies x and y by the device pixel ratio on iOS only', () => {
      const android = preset('offset').build(metrics(390, 844, 'android', 3)).numbers;
      const ios = preset('offset').build(metrics(390, 844, 'ios', 3)).numbers;

      expect(ios.x).toBe((android.x ?? 0) * 3);
      expect(ios.y).toBe((android.y ?? 0) * 3);
      expect(ios.width).toBe(android.width);
      expect(ios.height).toBe(android.height);
    });

    it('sets the parent and drops x and y on the web', () => {
      const options = buildStartOptions(applyPreset(emptyStartForm(), preset('wide'), metrics(1280, 800, 'web', 1)));

      expect(options.parent).toBe(WEB_PARENT_ID);
      expect('x' in options).toBeFalse();
      expect('y' in options).toBeFalse();
      expect(options.width).toBeGreaterThan(0);
    });
  });

  describe('requestedRect', () => {
    it('is the whole viewport when no geometry is sent', () => {
      expect(requestedRect({}, metrics(393, 851))).toEqual({ x: 0, y: 0, width: 393, height: 851 });
    });

    it('subtracts paddingBottom even when height is omitted, as the documentation describes', () => {
      expect(requestedRect({ paddingBottom: 56 }, metrics(393, 851))).toEqual({ x: 0, y: 0, width: 393, height: 795 });
    });

    it('converts an iOS origin back to points', () => {
      expect(requestedRect({ x: 90, y: 300, width: 200, height: 100 }, metrics(390, 844, 'ios', 3))).toEqual({
        x: 30,
        y: 100,
        width: 200,
        height: 100,
      });
    });

    it('has no rectangle on the web', () => {
      expect(requestedRect({ width: 200, height: 100 }, metrics(1280, 800, 'web', 1))).toBeNull();
    });
  });

  describe('controlBand', () => {
    const viewport = metrics(393, 851);

    it('picks the larger free band', () => {
      expect(controlBand({ x: 0, y: 32, width: 393, height: 300 }, viewport)).toEqual({ top: 332, height: 519 });
      expect(controlBand({ x: 0, y: 500, width: 393, height: 351 }, viewport)).toEqual({ top: 0, height: 500 });
    });

    it('reports no band for a full-screen rectangle', () => {
      expect(controlBand({ x: 0, y: 0, width: 393, height: 851 }, viewport)).toBeNull();
    });

    it('reports no band when both free bands are too small', () => {
      expect(controlBand({ x: 0, y: 100, width: 393, height: 651 }, viewport)).toBeNull();
    });
  });

  describe('viewportOrientation', () => {
    it('is landscape only when the viewport is wider than tall', () => {
      expect(viewportOrientation({ width: 400, height: 800 })).toBe('portrait');
      expect(viewportOrientation({ width: 800, height: 400 })).toBe('landscape');
      expect(viewportOrientation({ width: 600, height: 600 })).toBe('portrait');
    });
  });

  describe('rectAfterOrientationChange', () => {
    const full = { x: 0, y: 0, width: 400, height: 800 };
    const wide = { x: 40, y: 120, width: 300, height: 200 };
    const tall = { x: 24, y: 96, width: 160, height: 280 };

    describe('on Android (the container exchanges its sides when its shape differs from the orientation)', () => {
      const turn = (current: typeof full, orientation: 'portrait' | 'landscape'): typeof full =>
        rectAfterOrientationChange('android', undefined, current, current, orientation);

      it('exchanges the sides of a full-screen preview and restores them on the way back', () => {
        const landscape = turn(full, 'landscape');
        expect(landscape).toEqual({ x: 0, y: 0, width: 800, height: 400 });
        expect(turn(landscape, 'portrait')).toEqual(full);
      });

      it('keeps the origin of an offset tall rectangle and exchanges its sides', () => {
        const landscape = turn(tall, 'landscape');
        expect(landscape).toEqual({ x: 24, y: 96, width: 280, height: 160 });
        expect(turn(landscape, 'portrait')).toEqual(tall);
      });

      it('leaves a wide rectangle alone in landscape and exchanges it on the way back to portrait', () => {
        const landscape = turn(wide, 'landscape');
        expect(landscape).toEqual(wide);
        expect(turn(landscape, 'portrait')).toEqual({ x: 40, y: 120, width: 200, height: 300 });
      });

      it('does not read rotateWhenOrientationChanged', () => {
        expect(rectAfterOrientationChange('android', false, tall, tall, 'landscape')).toEqual({
          x: 24,
          y: 96,
          width: 280,
          height: 160,
        });
      });

      it('treats a square as landscape-shaped, which changes nothing visible', () => {
        const square = { x: 10, y: 20, width: 200, height: 200 };
        expect(turn(square, 'portrait')).toEqual(square);
        expect(turn(square, 'landscape')).toEqual(square);
      });
    });

    describe('on iOS (recomputed from the start() values every time)', () => {
      it('transposes the origin and puts the longer side across in landscape', () => {
        expect(rectAfterOrientationChange('ios', undefined, tall, tall, 'landscape')).toEqual({
          x: 96,
          y: 24,
          width: 280,
          height: 160,
        });
        expect(rectAfterOrientationChange('ios', true, full, full, 'landscape')).toEqual({
          x: 0,
          y: 0,
          width: 800,
          height: 400,
        });
      });

      it('returns to the start origin with the longer side upright in portrait, whatever came before', () => {
        const landscape = rectAfterOrientationChange('ios', undefined, tall, tall, 'landscape');
        expect(rectAfterOrientationChange('ios', undefined, tall, landscape, 'portrait')).toEqual(tall);
        // A wide rectangle does not survive a round trip: portrait always makes the longer side the height.
        expect(rectAfterOrientationChange('ios', undefined, wide, wide, 'portrait')).toEqual({
          x: 40,
          y: 120,
          width: 200,
          height: 300,
        });
      });

      it('moves nothing with rotateWhenOrientationChanged: false', () => {
        expect(rectAfterOrientationChange('ios', false, tall, tall, 'landscape')).toEqual(tall);
      });
    });

    it('has nothing to move on the web', () => {
      expect(rectAfterOrientationChange('web', undefined, full, full, 'landscape')).toEqual(full);
    });
  });
});
