/** A native round snapshot, not the current state of the running RN instance. */
export interface NativeUpdateResult {
  /** skipped, noUpdate, downloaded, failed, or cancelled. */
  status: string;
  reason: string;
  hash: string;
  /** The version was selected for the next launch; no reload is performed. */
  activated: boolean;
}

export function nativeUpdateResult(
  status: string,
  reason: string = '',
  hash: string = '',
  activated: boolean = false,
): NativeUpdateResult {
  return { status, reason, hash, activated };
}

/** Internal gate shared by the delayed check and the native host API. */
export class NativeUpdateRound {
  private task: Promise<NativeUpdateResult> | undefined;

  run(operation: () => Promise<NativeUpdateResult>): Promise<NativeUpdateResult> {
    if (this.task !== undefined) {
      return this.task;
    }
    // Defer invocation until the promise is stored, including reentrant callers.
    this.task = Promise.resolve().then(operation);
    return this.task;
  }
}
