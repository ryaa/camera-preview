import { bytesToBase64 } from './image-inspector';
import { classifyImageResult, detectValueKind, expectedImageResult } from './result-classifier';
import { jpegFixture, pngFixture } from './testing/image-fixtures';

const JPEG_BASE64 = bytesToBase64(jpegFixture({ width: 1280, height: 720, exif: { orientation: 6 } }));
const PNG_BASE64 = bytesToBase64(pngFixture(640, 480));
const ANDROID_PATH = '/data/user/0/com.example.app/cache/cpcp_capture_1a145bf2.jpg';
const IOS_URL = 'file:///var/mobile/Containers/Data/Application/0000/Library/Caches/photo.jpg';

describe('result-classifier', () => {
  describe('detectValueKind', () => {
    it('treats a base64 JPEG as data even though it starts with a slash', () => {
      // The trap this module exists for: "/9j/" looks like the start of an absolute path.
      expect(JPEG_BASE64.startsWith('/9j/')).toBeTrue();
      expect(detectValueKind(JPEG_BASE64)).toEqual({ kind: 'base64', format: 'jpeg' });
    });

    it('recognises a base64 PNG', () => {
      expect(PNG_BASE64.startsWith('iVBORw0KGgo')).toBeTrue();
      expect(detectValueKind(PNG_BASE64)).toEqual({ kind: 'base64', format: 'png' });
    });

    it('recognises an Android cache path and an iOS file URL as files', () => {
      expect(detectValueKind(ANDROID_PATH)).toEqual({ kind: 'file', format: null });
      expect(detectValueKind(IOS_URL)).toEqual({ kind: 'file', format: null });
    });

    it('recognises a Capacitor WebView URL as a file reference', () => {
      expect(detectValueKind('https://localhost/_capacitor_file_/data/user/0/app/cache/a.jpg').kind).toBe('file');
    });

    it('classifies long base64 that is not an image as data of unknown format', () => {
      expect(detectValueKind('QUJD'.repeat(40))).toEqual({ kind: 'base64', format: 'unknown' });
    });

    it('reports empty and unrecognisable strings as unknown', () => {
      expect(detectValueKind('').kind).toBe('unknown');
      expect(detectValueKind('not a result').kind).toBe('unknown');
    });
  });

  describe('expectedImageResult', () => {
    it('expects Android capture() to follow storeToFile', () => {
      expect(expectedImageResult({ platform: 'android', method: 'capture', storeToFile: true, quality: 85 }).kind).toBe(
        'file',
      );
      expect(expectedImageResult({ platform: 'android', method: 'capture', storeToFile: false, quality: 85 }).kind).toBe(
        'base64',
      );
      expect(
        expectedImageResult({ platform: 'android', method: 'capture', storeToFile: undefined, quality: 85 }).kind,
      ).toBe('base64');
    });

    it('expects Android captureSample() to stay base64 whatever storeToFile says', () => {
      for (const storeToFile of [true, false, undefined]) {
        const expected = expectedImageResult({ platform: 'android', method: 'captureSample', storeToFile, quality: 85 });
        expect(expected.kind).withContext(`storeToFile ${storeToFile}`).toBe('base64');
        expect(expected.format).toBe('jpeg');
      }
    });

    it('expects iOS to return a file for both methods when storeToFile is set', () => {
      expect(expectedImageResult({ platform: 'ios', method: 'capture', storeToFile: true, quality: 85 }).kind).toBe('file');
      expect(expectedImageResult({ platform: 'ios', method: 'captureSample', storeToFile: true, quality: 85 }).kind).toBe(
        'file',
      );
      expect(expectedImageResult({ platform: 'ios', method: 'captureSample', storeToFile: false, quality: 85 }).kind).toBe(
        'base64',
      );
    });

    it('expects the web to return PNG when quality is omitted and JPEG when it is sent', () => {
      for (const method of ['capture', 'captureSample'] as const) {
        expect(expectedImageResult({ platform: 'web', method, storeToFile: true, quality: undefined }).format).toBe('png');
        expect(expectedImageResult({ platform: 'web', method, storeToFile: true, quality: 0 }).format).toBe('jpeg');
        expect(expectedImageResult({ platform: 'web', method, storeToFile: true, quality: 85 }).kind).toBe('base64');
      }
    });
  });

  describe('classifyImageResult', () => {
    it('accepts an Android sample that is base64 although storeToFile is true', () => {
      const result = classifyImageResult(JPEG_BASE64, {
        platform: 'android',
        method: 'captureSample',
        storeToFile: true,
        quality: 85,
      });

      expect(result.detected.kind).toBe('base64');
      expect(result.expected.kind).toBe('base64');
      expect(result.consistent).toBeTrue();
    });

    it('accepts an Android capture that is a file when storeToFile is true', () => {
      const result = classifyImageResult(ANDROID_PATH, {
        platform: 'android',
        method: 'capture',
        storeToFile: true,
        quality: 85,
      });

      expect(result.consistent).toBeTrue();
      expect(result.detected.kind).toBe('file');
    });

    it('accepts a web PNG when quality was omitted', () => {
      const result = classifyImageResult(PNG_BASE64, {
        platform: 'web',
        method: 'capture',
        storeToFile: undefined,
        quality: undefined,
      });

      expect(result.consistent).toBeTrue();
      expect(result.detected.format).toBe('png');
    });

    it('flags base64 where a file was expected', () => {
      const result = classifyImageResult(JPEG_BASE64, {
        platform: 'android',
        method: 'capture',
        storeToFile: true,
        quality: 85,
      });

      expect(result.consistent).toBeFalse();
      expect(result.note).toContain('Expected file');
    });

    it('flags a file where base64 was expected', () => {
      const result = classifyImageResult(ANDROID_PATH, {
        platform: 'android',
        method: 'captureSample',
        storeToFile: true,
        quality: 85,
      });

      expect(result.consistent).toBeFalse();
    });

    it('flags a JPEG where the web should have produced a PNG', () => {
      const result = classifyImageResult(JPEG_BASE64, {
        platform: 'web',
        method: 'capture',
        storeToFile: undefined,
        quality: undefined,
      });

      expect(result.consistent).toBeFalse();
      expect(result.note).toContain('png');
    });

    it('flags a value that is neither', () => {
      const result = classifyImageResult('', { platform: 'ios', method: 'capture', storeToFile: false, quality: 85 });

      expect(result.consistent).toBeFalse();
      expect(result.detected.kind).toBe('unknown');
    });
  });
});
