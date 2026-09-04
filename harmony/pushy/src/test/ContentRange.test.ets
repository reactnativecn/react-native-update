import { describe, it, expect } from '@ohos/hypium';
import { parseContentRangeTotal } from '../main/ets/DownloadTask';

// 续传响应头解析:206 的 Content-Range 决定追加的字节是否可信。
export default function contentRangeTest() {
  describe('parseContentRangeTotal', () => {
    it('returns the total for a well-formed range at the expected start', 0, () => {
      expect(parseContentRangeTotal('bytes 100-199/200', 100)).assertEqual(200);
      expect(parseContentRangeTotal('bytes 0-9/10', 0)).assertEqual(10);
    });

    it('tolerates surrounding whitespace', 0, () => {
      expect(parseContentRangeTotal('bytes  100-199 / 200 ', 100)).assertEqual(200);
    });

    it('returns 0 for an unknown total (*)', 0, () => {
      expect(parseContentRangeTotal('bytes 100-199/*', 100)).assertEqual(0);
    });

    it('rejects a start that does not match the local partial', 0, () => {
      expect(parseContentRangeTotal('bytes 50-199/200', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 0-199/200', 100)).assertEqual(-1);
    });

    it('rejects missing or foreign units', 0, () => {
      expect(parseContentRangeTotal('', 0)).assertEqual(-1);
      expect(parseContentRangeTotal('100-199/200', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('items 100-199/200', 100)).assertEqual(-1);
    });

    it('rejects malformed ranges', 0, () => {
      expect(parseContentRangeTotal('bytes 100-199', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100/200', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes */200', 0)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes abc-199/200', 100)).assertEqual(-1);
    });

    it('rejects non-positive or non-numeric totals', 0, () => {
      expect(parseContentRangeTotal('bytes 100-199/0', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100-199/-5', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100-199/abc', 100)).assertEqual(-1);
    });

    // 数值 total 必须大于 end(RFC 9110 §14.4);end 不能在 start 之前。
    it('rejects a range that contradicts its total', 0, () => {
      expect(parseContentRangeTotal('bytes 100-199/199', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100-199/150', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100-99/200', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100-99/*', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100-x/200', 100)).assertEqual(-1);
      expect(parseContentRangeTotal('bytes 100-100/200', 100)).assertEqual(200);
    });
  });
}
