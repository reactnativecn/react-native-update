import { describe, expect, test } from 'bun:test';
import {
  asUpdateErrorCode,
  readErrorCode,
  toUpdateError,
  UpdateError,
} from '../error';

describe('asUpdateErrorCode', () => {
  test('narrows to the stable set and drops foreign codes', () => {
    expect(asUpdateErrorCode('PATCH_FAILED')).toBe('PATCH_FAILED');
    expect(asUpdateErrorCode('ERR_NETWORK')).toBeUndefined();
    expect(asUpdateErrorCode('ECONNREFUSED')).toBeUndefined();
    expect(asUpdateErrorCode(undefined)).toBeUndefined();
    expect(asUpdateErrorCode(42)).toBeUndefined();
  });
});

describe('readErrorCode (cross-platform `[CODE] ` message contract)', () => {
  // A bridge that cannot set `code` on its rejection (Harmony) prefixes the
  // message instead; both spellings must classify the same way.
  test('reads a known code from the message prefix and strips it', () => {
    expect(
      readErrorCode(new Error('[PATCH_FAILED] copiesCrc mismatch'))
    ).toEqual({ code: 'PATCH_FAILED', message: 'copiesCrc mismatch' });
    expect(readErrorCode('[DOWNLOAD_FAILED] stream reset')).toEqual({
      code: 'DOWNLOAD_FAILED',
      message: 'stream reset',
    });
  });

  test('a code property wins over the prefix', () => {
    const e: any = new Error('[PATCH_FAILED] copiesCrc mismatch');
    e.code = 'DOWNLOAD_FAILED';
    expect(readErrorCode(e)).toEqual({
      code: 'DOWNLOAD_FAILED',
      message: 'copiesCrc mismatch',
    });
  });

  test('an unknown prefix is not a code and stays in the message', () => {
    expect(readErrorCode(new Error('[E_NOPE] something'))).toEqual({
      code: undefined,
      message: '[E_NOPE] something',
    });
    // No space after the bracket: not the contract's shape.
    expect(readErrorCode(new Error('[PATCH_FAILED]x'))).toEqual({
      code: undefined,
      message: '[PATCH_FAILED]x',
    });
  });

  test('non-error values yield an empty message', () => {
    expect(readErrorCode(undefined)).toEqual({
      code: undefined,
      message: '',
    });
    expect(readErrorCode(null)).toEqual({ code: undefined, message: '' });
    expect(readErrorCode({ code: 'RESET_FAILED' })).toEqual({
      code: 'RESET_FAILED',
      message: '',
    });
  });
});

describe('toUpdateError', () => {
  test('keeps an Error identity and stamps the fallback code', () => {
    const e = new Error('offline');
    const err = toUpdateError(e, 'CHECK_FAILED');
    expect(err).toBe(e as UpdateError);
    expect(err.code).toBe('CHECK_FAILED');
  });

  test('keeps a known upstream code instead of the fallback', () => {
    const e: any = new Error('empty hash');
    e.code = 'INVALID_OPTIONS';
    expect(toUpdateError(e, 'SWITCH_VERSION_FAILED').code).toBe(
      'INVALID_OPTIONS'
    );
  });

  test('overwrites a foreign code with ours', () => {
    const e: any = new Error('axios');
    e.code = 'ERR_NETWORK';
    expect(toUpdateError(e, 'CHECK_FAILED').code).toBe('CHECK_FAILED');
  });

  test('moves a `[CODE] ` message prefix onto the code property', () => {
    const e = new Error('[PATCH_FAILED] copiesCrc mismatch');
    const err = toUpdateError(e, 'DOWNLOAD_FAILED');
    expect(err).toBe(e as UpdateError);
    expect(err.code).toBe('PATCH_FAILED');
    expect(err.message).toBe('copiesCrc mismatch');
  });

  test('wraps a prefixed string rejection the same way', () => {
    const err = toUpdateError('[RESTART_FAILED] no activity', 'RESTART_FAILED');
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.code).toBe('RESTART_FAILED');
    expect(err.message).toBe('no activity');
  });

  test('wraps non-Error values with the fallback code', () => {
    expect(toUpdateError('boom', 'CHECK_FAILED')).toMatchObject({
      message: 'boom',
      code: 'CHECK_FAILED',
    });
    expect(toUpdateError(undefined, 'CHECK_FAILED').message).toBe(
      'CHECK_FAILED'
    );
  });

  test('a frozen Error is wrapped, with the prefix code still extracted', () => {
    const frozen = Object.freeze(new Error('[PATCH_FAILED] frozen'));
    const err = toUpdateError(frozen, 'DOWNLOAD_FAILED');
    expect(err).not.toBe(frozen as UpdateError);
    expect(err.code).toBe('PATCH_FAILED');
    expect(err.message).toBe('frozen');
    expect(err.cause).toBe(frozen);
  });
});
