import type { CameraPreviewFlashMode, CameraPreviewPlugin } from '@capacitor-community/camera-preview';

import type { MethodName } from '../capabilities';

type Behaviour = (args: unknown, callIndex: number) => Promise<unknown>;

/**
 * A scriptable stand-in for the plugin. Each method records its arguments and then does whatever
 * the test configured for it: resolve a value, reject, or stay pending for ever.
 */
export class FakeCameraPreview implements CameraPreviewPlugin {
  public readonly calls: { method: MethodName; args: unknown }[] = [];

  private readonly behaviours = new Map<MethodName, Behaviour>();

  public resolves(method: MethodName, value?: unknown): this {
    this.behaviours.set(method, () => Promise.resolve(value));
    return this;
  }

  public rejects(method: MethodName, error: unknown): this {
    this.behaviours.set(method, () => Promise.reject(error));
    return this;
  }

  public throws(method: MethodName, error: Error): this {
    this.behaviours.set(method, () => {
      throw error;
    });
    return this;
  }

  /** Full control: `callIndex` is 0 for the first call to this method, 1 for the second, and so on. */
  public answers(method: MethodName, behaviour: Behaviour): this {
    this.behaviours.set(method, behaviour);
    return this;
  }

  public neverSettles(method: MethodName): this {
    this.behaviours.set(method, () => new Promise<unknown>(() => undefined));
    return this;
  }

  /** Returns a function that settles the pending call later, to test late settlement. */
  public settlesLater(method: MethodName): { resolve: (value?: unknown) => void; reject: (error: unknown) => void } {
    let resolveLater: (value?: unknown) => void = () => undefined;
    let rejectLater: (error: unknown) => void = () => undefined;
    this.behaviours.set(
      method,
      () =>
        new Promise<unknown>((resolve, reject) => {
          resolveLater = resolve;
          rejectLater = reject;
        }),
    );
    return { resolve: (value) => resolveLater(value), reject: (error) => rejectLater(error) };
  }

  public countOf(method: MethodName): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  public start(options: unknown): Promise<void> {
    return this.run('start', options).then(() => undefined);
  }

  public stop(): Promise<void> {
    return this.run('stop', undefined).then(() => undefined);
  }

  public flip(): Promise<void> {
    return this.run('flip', undefined).then(() => undefined);
  }

  public setFlashMode(options: unknown): Promise<void> {
    return this.run('setFlashMode', options).then(() => undefined);
  }

  public setOpacity(options: unknown): Promise<void> {
    return this.run('setOpacity', options).then(() => undefined);
  }

  // The real implementations resolve values the declared `Promise<void>` hides, so these two pass
  // the configured value through untouched.
  public startRecordVideo(options: unknown): Promise<void> {
    return this.run('startRecordVideo', options).then((value) => value as void);
  }

  public stopRecordVideo(): Promise<void> {
    return this.run('stopRecordVideo', undefined).then((value) => value as void);
  }

  public capture(options: unknown): Promise<{ value: string }> {
    return this.run('capture', options).then((value) => value as { value: string });
  }

  public captureSample(options: unknown): Promise<{ value: string }> {
    return this.run('captureSample', options).then((value) => value as { value: string });
  }

  public getSupportedFlashModes(): Promise<{ result: CameraPreviewFlashMode[] }> {
    return this.run('getSupportedFlashModes', undefined).then((value) => value as { result: CameraPreviewFlashMode[] });
  }

  public isCameraStarted(): Promise<{ value: boolean }> {
    return this.run('isCameraStarted', undefined).then((value) => value as { value: boolean });
  }

  private run(method: MethodName, args: unknown): Promise<unknown> {
    const callIndex = this.countOf(method);
    this.calls.push({ method, args });
    const behaviour = this.behaviours.get(method);
    if (!behaviour) {
      return Promise.reject(new Error(`FakeCameraPreview: no behaviour configured for ${method}()`));
    }
    return behaviour(args, callIndex);
  }
}
