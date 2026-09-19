import { describe, expect, test } from 'bun:test';
import {
  NativeUpdateRound,
  nativeUpdateResult,
} from '../../harmony/pushy/src/main/ets/NativeUpdateResult';
import type { NativeUpdateResult } from '../../harmony/pushy/src/main/ets/NativeUpdateResult';

describe('native host update round', () => {
  test('concurrent callers share the same in-flight operation', async () => {
    const round = new NativeUpdateRound();
    let calls = 0;
    let complete: (result: NativeUpdateResult) => void = () => {};
    const operation = () => {
      calls += 1;
      return new Promise<NativeUpdateResult>((resolve) => {
        complete = resolve;
      });
    };
    const first = round.run(operation);
    const second = round.run(operation);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    const result = nativeUpdateResult('downloaded', '', 'version-1', true);
    complete(result);
    expect(await first).toEqual(result);
    expect(await second).toEqual(result);
    expect(await round.run(operation)).toEqual(result);
    expect(calls).toBe(1);
  });

  test('the promise is published before a reentrant caller runs', async () => {
    const round = new NativeUpdateRound();
    let nested: Promise<NativeUpdateResult> | undefined;
    const first = round.run(async () => {
      nested = round.run(async () => {
        throw new Error('a second operation must not execute');
      });
      return nativeUpdateResult('noUpdate', 'up_to_date');
    });
    await first;
    expect(nested).toBe(first);
  });

  test('a failed round is reused rather than causing a retry storm', async () => {
    const round = new NativeUpdateRound();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return nativeUpdateResult('failed', 'download_failed');
    };
    expect((await round.run(operation)).status).toBe('failed');
    expect((await round.run(operation)).reason).toBe('download_failed');
    expect(calls).toBe(1);
  });

  test('unexpected rejection also cannot start a second round', async () => {
    const round = new NativeUpdateRound();
    let calls = 0;
    const operation = async (): Promise<NativeUpdateResult> => {
      calls += 1;
      throw new Error('transport unavailable');
    };
    const first = round.run(operation);
    await expect(first).rejects.toThrow('transport unavailable');
    expect(round.run(operation)).toBe(first);
    expect(calls).toBe(1);
  });

  test('download and activation are separate facts', () => {
    expect(nativeUpdateResult('downloaded', '', 'version-1')).toEqual({
      status: 'downloaded',
      reason: '',
      hash: 'version-1',
      activated: false,
    });
    expect(nativeUpdateResult('downloaded', '', 'version-1', true).activated).toBe(
      true,
    );
    expect(nativeUpdateResult('skipped', 'not_configured')).toEqual({
      status: 'skipped',
      reason: 'not_configured',
      hash: '',
      activated: false,
    });
  });
});
