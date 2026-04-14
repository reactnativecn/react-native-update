import { describe, it, expect } from '@ohos/hypium';
import { validateHashInfo, getErrorMessage } from '../main/ets/PushyTurboModule';

export default function validationTest() {
  describe('validateHashInfo', () => {
    it('accepts valid JSON object', 0, () => {
      let threw = false;
      try {
        validateHashInfo('{"name":"v1"}');
      } catch {
        threw = true;
      }
      expect(threw).assertEqual(false);
    });

    it('accepts empty JSON object', 0, () => {
      let threw = false;
      try {
        validateHashInfo('{}');
      } catch {
        threw = true;
      }
      expect(threw).assertEqual(false);
    });

    it('rejects JSON array', 0, () => {
      let threw = false;
      try {
        validateHashInfo('[1,2,3]');
      } catch {
        threw = true;
      }
      expect(threw).assertEqual(true);
    });

    it('rejects plain string', 0, () => {
      let threw = false;
      try {
        validateHashInfo('"hello"');
      } catch {
        threw = true;
      }
      expect(threw).assertEqual(true);
    });

    it('rejects invalid JSON', 0, () => {
      let threw = false;
      try {
        validateHashInfo('{invalid}');
      } catch {
        threw = true;
      }
      expect(threw).assertEqual(true);
    });

    it('rejects null JSON', 0, () => {
      let threw = false;
      try {
        validateHashInfo('null');
      } catch {
        threw = true;
      }
      expect(threw).assertEqual(true);
    });
  });

  describe('getErrorMessage', () => {
    it('extracts message from Error object', 0, () => {
      const err = new Error('something broke');
      expect(getErrorMessage(err)).assertEqual('something broke');
    });

    it('extracts message from plain object with message property', 0, () => {
      const err = { message: 'custom error', code: 42 };
      expect(getErrorMessage(err)).assertEqual('custom error');
    });

    it('converts string to string', 0, () => {
      expect(getErrorMessage('raw string')).assertEqual('raw string');
    });

    it('converts number to string', 0, () => {
      expect(getErrorMessage(404)).assertEqual('404');
    });

    it('converts null to string', 0, () => {
      expect(getErrorMessage(null)).assertEqual('null');
    });

    it('converts undefined to string', 0, () => {
      expect(getErrorMessage(undefined)).assertEqual('undefined');
    });
  });
}
