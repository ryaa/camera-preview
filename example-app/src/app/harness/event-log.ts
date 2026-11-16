import type { MethodName } from './capabilities';
import { base64ToBytes, detectImageFormat } from './image-inspector';

/**
 * Bounded log of everything the harness did and observed. Image payloads never enter it: a result
 * is summarised as its keys with lengths, so the log stays small enough to copy into a bug report.
 */

export type LogKind =
  | 'call'
  | 'resolved'
  | 'rejected'
  | 'unsettled'
  | 'late'
  | 'readiness'
  | 'lifecycle'
  | 'note';

export interface LogEntry {
  seq: number;
  /** ISO wall-clock time. */
  time: string;
  /** Milliseconds since the harness loaded. */
  atMs: number;
  kind: LogKind;
  /** Correlates a `call` entry with its settlement. */
  callId?: number;
  method?: MethodName;
  args?: unknown;
  durationMs?: number;
  result?: unknown;
  error?: string;
  /** True when a rejection comes from a method this platform does not implement. */
  expectedUnsupported?: boolean;
  text?: string;
}

export type LogInput = Omit<LogEntry, 'seq' | 'time' | 'atMs'>;

export const LOG_CAPACITY = 300;
/** Paths, messages and file URLs stay readable; anything longer is a payload. */
const INLINE_STRING_LIMIT = 200;

export class EventLog {
  private entries: LogEntry[] = [];
  private seq = 0;

  constructor(
    private readonly capacity = LOG_CAPACITY,
    private readonly clock: () => number = () => performance.now(),
    private readonly wallClock: () => Date = () => new Date(),
  ) {}

  public add(input: LogInput): LogEntry {
    const entry: LogEntry = {
      seq: ++this.seq,
      time: this.wallClock().toISOString(),
      atMs: Math.round(this.clock()),
      ...input,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  public snapshot(): LogEntry[] {
    return this.entries.slice();
  }

  public clear(): void {
    this.entries = [];
  }
}

const BASE64_HEAD = /^[A-Za-z0-9+/]{16}/;

/** True when the string is base64 image data, however short: decided by the image's magic bytes. */
function isImagePayload(value: string): boolean {
  return BASE64_HEAD.test(value) && detectImageFormat(base64ToBytes(value.slice(0, 16))) !== 'unknown';
}

/**
 * Replaces image data and other long strings by a description of their length, so a payload never
 * reaches the log. Short strings (paths, messages, flash modes) are kept verbatim.
 */
export function summarizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (isImagePayload(value)) {
      return `base64[${value.length}]`;
    }
    if (value.length <= INLINE_STRING_LIMIT) {
      return value;
    }
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 256))
      ? `base64[${value.length}]`
      : `string[${value.length}] ${value.slice(0, 64)}…`;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= 4) {
    return '[nested]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeValue(item, depth + 1));
  }
  const summary: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    summary[key] = summarizeValue(item, depth + 1);
  }
  return summary;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

export function formatLogEntry(entry: LogEntry): string {
  const head = `${entry.time.slice(11, 23)} +${entry.atMs}ms`;
  const subject = entry.method ? `${entry.method}()` : '';
  const id = entry.callId === undefined ? '' : ` #${entry.callId}`;

  switch (entry.kind) {
    case 'call':
      return `${head} → ${subject}${id} ${JSON.stringify(entry.args ?? {})}`;
    case 'resolved':
      return `${head} ✓ ${subject}${id} ${entry.durationMs}ms ${JSON.stringify(entry.result ?? null)}`;
    case 'rejected':
      return `${head} ${entry.expectedUnsupported ? '∅' : '✗'} ${subject}${id} ${entry.durationMs}ms ${entry.error ?? ''}${
        entry.expectedUnsupported ? ' (unsupported on this platform — expected)' : ''
      }`;
    case 'unsettled':
      return `${head} … ${subject}${id} not settled after ${entry.durationMs}ms`;
    case 'late':
      return `${head} ⏱ ${subject}${id} settled late after ${entry.durationMs}ms: ${entry.text ?? ''}`;
    default:
      return `${head} [${entry.kind}] ${entry.text ?? ''}`;
  }
}
