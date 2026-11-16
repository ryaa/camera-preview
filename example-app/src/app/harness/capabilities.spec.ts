import {
  COVERAGE_ITEMS,
  METHOD_NAMES,
  coverageIdsForCall,
  coverageItem,
  isExpectedUnsupported,
  normalizePlatform,
  supportFor,
  supportSymbol,
} from './capabilities';
import { START_OPTION_KEYS } from './option-model';

describe('capabilities', () => {
  it('lists the 11 public methods', () => {
    expect(METHOD_NAMES.length).toBe(11);
    expect(new Set(METHOD_NAMES).size).toBe(11);
  });

  it('has a coverage row for every method', () => {
    for (const method of METHOD_NAMES) {
      expect(coverageItem(method)?.kind).withContext(method).toBe('method');
    }
  });

  it('has a coverage row for every start() option', () => {
    for (const key of START_OPTION_KEYS) {
      expect(coverageItem(`start.${key}`)?.kind).withContext(key).toBe('start-option');
    }
    expect(COVERAGE_ITEMS.filter((item) => item.kind === 'start-option').length).toBe(START_OPTION_KEYS.length);
  });

  it('has a coverage row for every option of the other calls, including the undeclared recording keys', () => {
    const ids = COVERAGE_ITEMS.filter((item) => item.kind === 'call-option').map((item) => item.id);

    expect(ids.sort()).toEqual(
      [
        'capture.quality',
        'capture.width',
        'capture.height',
        'captureSample.quality',
        'setOpacity.opacity',
        'setFlashMode.flashMode',
        'startRecordVideo.position',
        'startRecordVideo.width',
        'startRecordVideo.height',
        'startRecordVideo.withFlash',
        'startRecordVideo.maxDuration',
      ].sort(),
    );
    expect(coverageItem('startRecordVideo.withFlash')?.undeclared).toBeTrue();
    expect(coverageItem('startRecordVideo.maxDuration')?.undeclared).toBeTrue();
  });

  it('uses each id once and states support for all three platforms', () => {
    expect(new Set(COVERAGE_ITEMS.map((item) => item.id)).size).toBe(COVERAGE_ITEMS.length);
    for (const item of COVERAGE_ITEMS) {
      for (const platform of ['android', 'ios', 'web'] as const) {
        expect(['supported', 'partial', 'unsupported'])
          .withContext(`${item.id} on ${platform}`)
          .toContain(item.support[platform].level);
      }
    }
  });

  it('explains every partial or unsupported entry', () => {
    for (const item of COVERAGE_ITEMS) {
      for (const platform of ['android', 'ios', 'web'] as const) {
        const support = item.support[platform];
        if (support.level !== 'supported') {
          expect(support.note).withContext(`${item.id} on ${platform}`).toBeTruthy();
        }
      }
    }
  });

  it('treats a rejection as expected only where the method is unsupported', () => {
    expect(isExpectedUnsupported('isCameraStarted', 'web')).toBeTrue();
    expect(isExpectedUnsupported('flip', 'web')).toBeTrue();
    expect(isExpectedUnsupported('setOpacity', 'ios')).toBeTrue();
    expect(isExpectedUnsupported('startRecordVideo', 'web')).toBeTrue();

    expect(isExpectedUnsupported('isCameraStarted', 'android')).toBeFalse();
    expect(isExpectedUnsupported('capture', 'web')).toBeFalse();
    // Partial support is not "unsupported": a rejection there is a real failure.
    expect(isExpectedUnsupported('setOpacity', 'android')).toBeFalse();
    expect(isExpectedUnsupported('stopRecordVideo', 'ios')).toBeFalse();
  });

  it('marks the method and each option key that was sent as exercised', () => {
    expect(coverageIdsForCall('start', { position: 'rear', toBack: true, unknownKey: 1 })).toEqual([
      'start',
      'start.position',
      'start.toBack',
    ]);
    expect(coverageIdsForCall('capture', {})).toEqual(['capture']);
    expect(coverageIdsForCall('stop', undefined)).toEqual(['stop']);
    expect(coverageIdsForCall('startRecordVideo', { withFlash: true, maxDuration: 1000 })).toEqual([
      'startRecordVideo',
      'startRecordVideo.withFlash',
      'startRecordVideo.maxDuration',
    ]);
  });

  it('falls back to "supported" for an unknown id and maps platform names', () => {
    expect(supportFor('nothing', 'android').level).toBe('supported');
    expect(normalizePlatform('android')).toBe('android');
    expect(normalizePlatform('ios')).toBe('ios');
    expect(normalizePlatform('web')).toBe('web');
    expect(normalizePlatform('electron')).toBe('web');
    expect([supportSymbol('supported'), supportSymbol('partial'), supportSymbol('unsupported')]).toEqual(['✓', '◐', '✗']);
  });
});
