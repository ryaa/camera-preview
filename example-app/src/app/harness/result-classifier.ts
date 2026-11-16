import type { HarnessPlatform } from './capabilities';
import { base64ToBytes, detectImageFormat } from './image-inspector';
import type { ImageFormat } from './image-inspector';

/**
 * Decides what a `{ value }` result is — a file reference or base64 image data — from two
 * independent sources that are then compared:
 *
 *  1. what the platform is expected to return for this method and these options, and
 *  2. what the returned string demonstrably is.
 *
 * Neither source is enough alone. The `storeToFile` flag does not decide it (Android's
 * `captureSample()` returns base64 even with the flag set), and the string's first character does
 * not decide it either (a base64 JPEG starts with `/9j/`, which looks like an absolute path).
 */

export type ImageMethod = 'capture' | 'captureSample';
export type ValueKind = 'base64' | 'file' | 'unknown';

export interface ResultExpectation {
  kind: 'base64' | 'file';
  /** Format the platform should produce; `null` when the harness has no expectation. */
  format: ImageFormat | null;
  reason: string;
}

export interface DetectedValue {
  kind: ValueKind;
  /** Format read from the first decoded bytes; only set for base64 values. */
  format: ImageFormat | null;
}

export interface ResultClassification {
  expected: ResultExpectation;
  detected: DetectedValue;
  /** False when the returned value is not what the platform contract predicts. */
  consistent: boolean;
  note: string;
}

export interface ExpectationInput {
  platform: HarnessPlatform;
  method: ImageMethod;
  /** `storeToFile` as sent to `start()`; `undefined` when the key was omitted. */
  storeToFile: boolean | undefined;
  /** `quality` as sent to the call; `undefined` when the key was omitted. */
  quality: number | undefined;
}

export function expectedImageResult(input: ExpectationInput): ResultExpectation {
  const { platform, method, storeToFile, quality } = input;

  if (platform === 'web') {
    return quality === undefined
      ? { kind: 'base64', format: 'png', reason: 'web returns a PNG data string when quality is omitted' }
      : { kind: 'base64', format: 'jpeg', reason: 'web returns a JPEG data string when quality is sent' };
  }

  if (platform === 'android') {
    if (method === 'captureSample') {
      return {
        kind: 'base64',
        format: 'jpeg',
        reason: 'Android captureSample() always returns base64, whatever storeToFile says',
      };
    }
    return storeToFile === true
      ? { kind: 'file', format: 'jpeg', reason: 'Android capture() with storeToFile: true returns a cache file path' }
      : { kind: 'base64', format: 'jpeg', reason: 'Android capture() without storeToFile returns base64' };
  }

  return storeToFile === true
    ? { kind: 'file', format: 'jpeg', reason: `iOS ${method}() with storeToFile: true returns a file URL` }
    : { kind: 'base64', format: 'jpeg', reason: `iOS ${method}() without storeToFile returns base64` };
}

const BASE64_HEAD = /^[A-Za-z0-9+/]{16}/;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Classifies the string itself. Image magic bytes win over anything the string looks like. */
export function detectValueKind(value: string): DetectedValue {
  if (value.length === 0) {
    return { kind: 'unknown', format: null };
  }
  if (URL_SCHEME.test(value)) {
    return { kind: 'file', format: null };
  }

  if (BASE64_HEAD.test(value)) {
    const format = detectImageFormat(base64ToBytes(value.slice(0, 16)));
    if (format !== 'unknown') {
      return { kind: 'base64', format };
    }
  }

  if (value.startsWith('/')) {
    return { kind: 'file', format: null };
  }
  // Long, purely base64 text that is not a recognised image is still data, not a path.
  if (value.length >= 64 && BASE64_BODY.test(value)) {
    return { kind: 'base64', format: 'unknown' };
  }

  return { kind: 'unknown', format: null };
}

export function classifyImageResult(value: string, input: ExpectationInput): ResultClassification {
  const expected = expectedImageResult(input);
  const detected = detectValueKind(value);

  if (detected.kind === 'unknown') {
    return { expected, detected, consistent: false, note: 'The returned string is neither a path nor image data.' };
  }
  if (detected.kind !== expected.kind) {
    return {
      expected,
      detected,
      consistent: false,
      note: `Expected ${expected.kind} (${expected.reason}) but the value is ${detected.kind}.`,
    };
  }
  if (detected.kind === 'base64' && expected.format !== null && detected.format !== expected.format) {
    return {
      expected,
      detected,
      consistent: false,
      note: `Expected ${expected.format} data (${expected.reason}) but the bytes are ${detected.format ?? 'unknown'}.`,
    };
  }

  return { expected, detected, consistent: true, note: expected.reason };
}
