import {
  START_OPTION_KEYS,
  buildCaptureOptions,
  buildOpacityOptions,
  buildRecordOptions,
  buildSampleOptions,
  buildStartOptions,
  emptyCaptureForm,
  emptyRecordForm,
  emptyStartForm,
  parseFlashOptions,
  parseOpacityOptions,
  parsePictureOptions,
  parseRecordOptions,
  parseSampleOptions,
  parseStartOptions,
  startFormFromOptions,
} from './option-model';

describe('option-model', () => {
  describe('buildStartOptions', () => {
    it('sends nothing for an untouched form', () => {
      expect(buildStartOptions(emptyStartForm())).toEqual({});
    });

    it('covers all 17 start options', () => {
      expect(START_OPTION_KEYS.length).toBe(17);
      expect(new Set(START_OPTION_KEYS).size).toBe(17);
    });

    it('distinguishes unset, true and false for a boolean', () => {
      const form = emptyStartForm();

      form.booleans.toBack = 'false';
      expect(buildStartOptions(form)).toEqual({ toBack: false });

      form.booleans.toBack = 'true';
      expect(buildStartOptions(form)).toEqual({ toBack: true });

      form.booleans.toBack = 'unset';
      expect('toBack' in buildStartOptions(form)).toBeFalse();
    });

    it('sends zero and fractional numbers as typed', () => {
      const form = emptyStartForm();
      form.numbers.x = { send: true, value: 0 };
      form.numbers.width = { send: true, value: 200.5 };

      expect(buildStartOptions(form)).toEqual({ x: 0, width: 200.5 });
    });

    it('keeps a typed value while the key is not sent', () => {
      const form = emptyStartForm();
      form.numbers.paddingBottom = { send: false, value: 56 };

      expect(buildStartOptions(form)).toEqual({});
      expect(form.numbers.paddingBottom.value).toBe(56);
    });

    it('does not send a ticked number that has no value', () => {
      const form = emptyStartForm();
      form.numbers.height = { send: true, value: null };

      expect(buildStartOptions(form)).toEqual({});
    });

    it('sends an empty string when a text option is ticked', () => {
      const form = emptyStartForm();
      form.texts.position = { send: true, value: '' };

      expect(buildStartOptions(form)).toEqual({ position: '' });
    });

    it('never emits a key with the value undefined', () => {
      const form = emptyStartForm();
      form.booleans.storeToFile = 'true';
      form.numbers.y = { send: true, value: 12 };

      for (const value of Object.values(buildStartOptions(form))) {
        expect(value).not.toBeUndefined();
      }
    });
  });

  describe('startFormFromOptions', () => {
    it('round-trips an option object', () => {
      const options = {
        position: 'front',
        parent: 'content',
        x: 0,
        y: 120,
        width: 300,
        height: 200,
        paddingBottom: 56,
        toBack: false,
        storeToFile: true,
        disableExifHeaderStripping: false,
        enableZoom: true,
      };

      expect(buildStartOptions(startFormFromOptions(options))).toEqual(options);
    });
  });

  describe('call option builders', () => {
    it('sends quality 85 for a capture by default and nothing else', () => {
      expect(buildCaptureOptions(emptyCaptureForm())).toEqual({ quality: 85 });
    });

    it('omits quality when it is unticked, which makes the web return PNG', () => {
      const form = emptyCaptureForm();
      form.quality = { send: false, value: 85 };

      expect(buildCaptureOptions(form)).toEqual({});
      expect(buildSampleOptions({ quality: form.quality })).toEqual({});
    });

    it('sends capture width and height independently', () => {
      const form = emptyCaptureForm();
      form.width = { send: true, value: 640 };

      expect(buildCaptureOptions(form)).toEqual({ quality: 85, width: 640 });
    });

    it('sends opacity 0', () => {
      expect(buildOpacityOptions({ opacity: { send: true, value: 0 } })).toEqual({ opacity: 0 });
    });

    it('builds recording options including the two undeclared keys', () => {
      const form = emptyRecordForm();
      expect(buildRecordOptions(form)).toEqual({});

      form.withFlash = 'true';
      form.maxDuration = { send: true, value: 1500 };
      form.position = { send: true, value: 'rear' };
      expect(buildRecordOptions(form)).toEqual({ position: 'rear', withFlash: true, maxDuration: 1500 });
    });
  });

  describe('parsers for untyped input', () => {
    it('keeps correctly typed start options and reports the rest', () => {
      const { options, dropped } = parseStartOptions({
        position: 'rear',
        toBack: true,
        width: 300,
        height: '200',
        enableZoom: 'yes',
        notAnOption: 1,
      });

      expect(options).toEqual({ position: 'rear', toBack: true, width: 300 });
      expect(dropped.sort()).toEqual(['enableZoom', 'height', 'notAnOption']);
    });

    it('returns empty options for anything that is not an object', () => {
      expect(parseStartOptions(undefined).options).toEqual({});
      expect(parseStartOptions('rear').options).toEqual({});
      expect(parseStartOptions([1, 2]).options).toEqual({});
      expect(parseStartOptions(null).options).toEqual({});
    });

    it('parses picture, sample, opacity, flash and record options', () => {
      expect(parsePictureOptions({ quality: 20, width: 640, height: 480, extra: true })).toEqual({
        quality: 20,
        width: 640,
        height: 480,
      });
      expect(parsePictureOptions({ quality: '20' })).toEqual({});
      expect(parseSampleOptions({ quality: 0, width: 10 })).toEqual({ quality: 0 });
      expect(parseOpacityOptions({ opacity: 0 })).toEqual({ opacity: 0 });
      expect(parseOpacityOptions({})).toEqual({});
      expect(parseFlashOptions({ flashMode: 'torch' })).toEqual({ flashMode: 'torch' });
      expect(parseFlashOptions(undefined)).toEqual({ flashMode: '' });
      expect(parseRecordOptions({ position: 'rear', withFlash: true, maxDuration: 1500, width: 640 })).toEqual({
        position: 'rear',
        width: 640,
        withFlash: true,
        maxDuration: 1500,
      });
    });
  });
});
