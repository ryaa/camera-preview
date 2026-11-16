import { EventLog, errorCode, errorMessage, formatLogEntry, summarizeValue } from './event-log';

describe('event-log', () => {
  describe('EventLog', () => {
    it('numbers entries and stamps them with the injected clocks', () => {
      const log = new EventLog(
        10,
        () => 1234.6,
        () => new Date('2026-11-15T10:20:30.456Z'),
      );

      const entry = log.add({ kind: 'note', text: 'hello' });

      expect(entry).toEqual({ seq: 1, time: '2026-11-15T10:20:30.456Z', atMs: 1235, kind: 'note', text: 'hello' });
      expect(log.add({ kind: 'note', text: 'again' }).seq).toBe(2);
    });

    it('keeps only the newest entries once the capacity is reached', () => {
      const log = new EventLog(3);
      for (let index = 1; index <= 5; index++) {
        log.add({ kind: 'note', text: `entry ${index}` });
      }

      expect(log.snapshot().map((entry) => entry.text)).toEqual(['entry 3', 'entry 4', 'entry 5']);
      expect(log.snapshot().map((entry) => entry.seq)).toEqual([3, 4, 5]);
    });

    it('returns a copy and can be cleared', () => {
      const log = new EventLog();
      log.add({ kind: 'note', text: 'one' });
      const snapshot = log.snapshot();
      snapshot.pop();

      expect(log.snapshot().length).toBe(1);
      log.clear();
      expect(log.snapshot()).toEqual([]);
    });
  });

  describe('summarizeValue', () => {
    it('replaces a base64 payload by its length', () => {
      const payload = '/9j/4AAQSkZJRgABAQ'.repeat(200);

      expect(summarizeValue({ value: payload })).toEqual({ value: `base64[${payload.length}]` });
    });

    it('keeps paths, file URLs and messages readable', () => {
      const path = '/data/user/0/com.example.app/cache/cpcp_capture_1a145bf2.jpg';
      const url = 'file:///var/mobile/Containers/Data/Application/2D6C7A0E-7F0B-4C5B-9B9F-0D4A54E2F0AA/Library/Caches/x.jpg';

      expect(summarizeValue({ value: path })).toEqual({ value: path });
      expect(summarizeValue({ value: url })).toEqual({ value: url });
      expect(summarizeValue('camera already started')).toBe('camera already started');
    });

    it('truncates long text that is not base64', () => {
      const text = 'An error: '.repeat(40);
      const summary = summarizeValue(text);

      expect(typeof summary).toBe('string');
      expect(String(summary).startsWith(`string[${text.length}]`)).toBeTrue();
      expect(String(summary).length).toBeLessThan(120);
    });

    it('walks arrays and nested objects and passes primitives through', () => {
      expect(summarizeValue({ result: ['off', 'on'], nested: { value: true, count: 3 }, nothing: null })).toEqual({
        result: ['off', 'on'],
        nested: { value: true, count: 3 },
        nothing: null,
      });
      expect(summarizeValue(undefined)).toBeUndefined();
    });

    it('never lets a payload through at any depth', () => {
      const payload = 'QUJD'.repeat(500);
      const summary = JSON.stringify(summarizeValue({ a: { b: { c: [payload] } } }));

      expect(summary).not.toContain(payload);
      expect(summary).toContain(`base64[${payload.length}]`);
    });
  });

  describe('error helpers', () => {
    it('reads the message of an Error, of a plain object and of anything else', () => {
      expect(errorMessage(new Error('boom'))).toBe('boom');
      expect(errorMessage({ message: 'camera already started' })).toBe('camera already started');
      expect(errorMessage({ message: 42 })).toBe('[object Object]');
      expect(errorMessage('plain')).toBe('plain');
      expect(errorMessage(undefined)).toBe('undefined');
    });

    it('reads a string code when there is one', () => {
      expect(errorCode({ code: 'UNIMPLEMENTED' })).toBe('UNIMPLEMENTED');
      expect(errorCode({ code: 7 })).toBeUndefined();
      expect(errorCode(new Error('no code'))).toBeUndefined();
      expect(errorCode(null)).toBeUndefined();
    });
  });

  describe('formatLogEntry', () => {
    const base = { seq: 1, time: '2026-11-15T10:20:30.456Z', atMs: 1500 };

    it('formats a call, its resolution and a rejection', () => {
      expect(formatLogEntry({ ...base, kind: 'call', callId: 4, method: 'capture', args: { quality: 85 } })).toBe(
        '10:20:30.456 +1500ms → capture() #4 {"quality":85}',
      );
      expect(
        formatLogEntry({ ...base, kind: 'resolved', callId: 4, method: 'capture', durationMs: 310, result: { value: 'x' } }),
      ).toBe('10:20:30.456 +1500ms ✓ capture() #4 310ms {"value":"x"}');
      expect(
        formatLogEntry({ ...base, kind: 'rejected', callId: 5, method: 'start', durationMs: 3, error: 'camera already started' }),
      ).toBe('10:20:30.456 +1500ms ✗ start() #5 3ms camera already started');
    });

    it('labels a rejection from an unsupported method as expected', () => {
      const line = formatLogEntry({
        ...base,
        kind: 'rejected',
        callId: 6,
        method: 'flip',
        durationMs: 1,
        error: 'flip not supported under the web platform',
        expectedUnsupported: true,
      });

      expect(line).toContain('∅ flip() #6');
      expect(line).toContain('unsupported on this platform — expected');
    });

    it('formats unsettled and late entries and plain notes', () => {
      expect(formatLogEntry({ ...base, kind: 'unsettled', callId: 7, method: 'setOpacity', durationMs: 3000 })).toContain(
        '… setOpacity() #7 not settled after 3000ms',
      );
      expect(
        formatLogEntry({ ...base, kind: 'late', callId: 7, method: 'setOpacity', durationMs: 5200, text: 'resolved' }),
      ).toContain('settled late after 5200ms: resolved');
      expect(formatLogEntry({ ...base, kind: 'readiness', text: 'isCameraStarted(): false → true' })).toBe(
        '10:20:30.456 +1500ms [readiness] isCameraStarted(): false → true',
      );
    });
  });
});
