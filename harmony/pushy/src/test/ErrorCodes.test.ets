import { describe, it, expect } from '@ohos/hypium';
import {
  ERROR_DOWNLOAD_FAILED,
  ERROR_PATCH_FAILED,
  UpdateError,
  createUpdateError,
  getErrorMessage,
  parseErrorCodePrefix,
  toUpdateError,
} from '../main/ets/ErrorCodes';

// 稳定错误码:`code` 属性 + `[CODE] ` 消息前缀(RNOH 桥丢属性时 JS 解析前缀)。
export default function errorCodesTest() {
  describe('ErrorCodes.createUpdateError', () => {
    it('sets the code and prefixes the message', 0, () => {
      const error = createUpdateError(ERROR_PATCH_FAILED, 'boom');
      expect(error instanceof Error).assertTrue();
      expect(error.code).assertEqual(ERROR_PATCH_FAILED);
      expect(error.message).assertEqual('[PATCH_FAILED] boom');
    });
  });

  describe('ErrorCodes.toUpdateError', () => {
    it('keeps an existing code and never double-prefixes', 0, () => {
      const original = createUpdateError(ERROR_PATCH_FAILED, 'boom');
      const wrapped = toUpdateError(original, ERROR_DOWNLOAD_FAILED);
      expect(wrapped === original).assertTrue();
      expect(wrapped.message).assertEqual('[PATCH_FAILED] boom');
    });

    it('assigns the default code to plain errors and values', 0, () => {
      const fromError = toUpdateError(new Error('plain'), ERROR_DOWNLOAD_FAILED);
      expect(fromError.code).assertEqual(ERROR_DOWNLOAD_FAILED);
      expect(fromError.message).assertEqual('[DOWNLOAD_FAILED] plain');
      const fromString = toUpdateError('raw', ERROR_DOWNLOAD_FAILED);
      expect(fromString instanceof UpdateError).assertTrue();
      expect(fromString.message).assertEqual('[DOWNLOAD_FAILED] raw');
    });
  });

  describe('ErrorCodes.parseErrorCodePrefix', () => {
    it('extracts a well-formed code', 0, () => {
      expect(parseErrorCodePrefix('[PATCH_FAILED] boom')).assertEqual('PATCH_FAILED');
    });

    it('returns an empty string otherwise', 0, () => {
      expect(parseErrorCodePrefix('boom')).assertEqual('');
      expect(parseErrorCodePrefix('[lower] boom')).assertEqual('');
      expect(parseErrorCodePrefix('[] boom')).assertEqual('');
      expect(parseErrorCodePrefix('[NO_SPACE]boom')).assertEqual('');
    });
  });

  describe('ErrorCodes.getErrorMessage', () => {
    it('reads messages from errors, objects and primitives', 0, () => {
      expect(getErrorMessage(new Error('e'))).assertEqual('e');
      expect(getErrorMessage({ message: 'm' })).assertEqual('m');
      expect(getErrorMessage('s')).assertEqual('s');
      expect(getErrorMessage(42)).assertEqual('42');
    });
  });
}
