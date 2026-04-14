import { describe, it, expect } from '@ohos/hypium';

export default function localUnitTest() {
  describe('localUnitTest', () => {
    it('JSON parse round-trip for update manifest', 0, () => {
      const manifest = {
        copies: { 'assets/icon.png': 'assets/original.png' },
        deletes: ['assets/old.png'],
      };
      const serialized = JSON.stringify(manifest);
      const parsed = JSON.parse(serialized);
      expect(parsed.copies['assets/icon.png']).assertEqual('assets/original.png');
      expect(parsed.deletes[0]).assertEqual('assets/old.png');
    });

    it('version string comparison works correctly', 0, () => {
      const v1 = '1.0.0';
      const v2 = '1.0.0';
      const v3 = '2.0.0';
      expect(v1 === v2).assertEqual(true);
      expect(v1 === v3).assertEqual(false);
    });

    it('hash string concatenation for kv keys', 0, () => {
      const hash = 'abc123';
      const key = `hash_${hash}`;
      expect(key).assertEqual('hash_abc123');
      expect(key).assertContain('hash_');
    });
  });
}
