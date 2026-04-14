import { describe, it, expect } from '@ohos/hypium';
import { parseManifestToArrays } from '../main/ets/DownloadTask';

export default function manifestParsingTest() {
  describe('parseManifestToArrays', () => {
    it('returns empty arrays for empty manifest', 0, () => {
      const result = parseManifestToArrays({}, false);
      expect(result.copyFroms.length).assertEqual(0);
      expect(result.copyTos.length).assertEqual(0);
      expect(result.deletes.length).assertEqual(0);
    });

    it('parses copies and deletes array', 0, () => {
      const manifest = {
        copies: {
          'assets/icon.png': 'assets/original.png',
          'assets/logo.png': 'assets/brand.png',
        },
        deletes: ['assets/old.png', 'assets/removed.txt'],
      };
      const result = parseManifestToArrays(manifest, false);
      expect(result.copyFroms.length).assertEqual(2);
      expect(result.copyTos.length).assertEqual(2);
      expect(result.copyFroms[0]).assertEqual('assets/original.png');
      expect(result.copyTos[0]).assertEqual('assets/icon.png');
      expect(result.copyFroms[1]).assertEqual('assets/brand.png');
      expect(result.copyTos[1]).assertEqual('assets/logo.png');
      expect(result.deletes.length).assertEqual(2);
      expect(result.deletes[0]).assertEqual('assets/old.png');
      expect(result.deletes[1]).assertEqual('assets/removed.txt');
    });

    it('parses deletes as object keys', 0, () => {
      const manifest = {
        deletes: {
          'assets/old.png': true,
          'assets/removed.txt': true,
        },
      };
      const result = parseManifestToArrays(manifest, false);
      expect(result.deletes.length).assertEqual(2);
      expect(result.deletes[0]).assertEqual('assets/old.png');
      expect(result.deletes[1]).assertEqual('assets/removed.txt');
    });

    it('handles missing copies gracefully', 0, () => {
      const manifest = {
        deletes: ['a.txt'],
      };
      const result = parseManifestToArrays(manifest, false);
      expect(result.copyFroms.length).assertEqual(0);
      expect(result.copyTos.length).assertEqual(0);
      expect(result.deletes.length).assertEqual(1);
    });

    it('handles missing deletes gracefully', 0, () => {
      const manifest = {
        copies: { 'a.png': 'b.png' },
      };
      const result = parseManifestToArrays(manifest, false);
      expect(result.deletes.length).assertEqual(0);
      expect(result.copyFroms.length).assertEqual(1);
    });

    it('normalizes resource copies when enabled', 0, () => {
      const manifest = {
        copies: {
          'assets/icon.png': 'resources/rawfile/assets/icon.png',
        },
      };
      const result = parseManifestToArrays(manifest, true);
      expect(result.copyFroms[0]).assertEqual('assets/icon.png');
      expect(result.copyTos[0]).assertEqual('assets/icon.png');
    });

    it('falls back to key when normalized from is empty', 0, () => {
      const manifest = {
        copies: {
          'assets/icon.png': 'resources/rawfile/',
        },
      };
      const result = parseManifestToArrays(manifest, true);
      expect(result.copyFroms[0]).assertEqual('assets/icon.png');
    });

    it('does not normalize when disabled', 0, () => {
      const manifest = {
        copies: {
          'assets/icon.png': 'resources/rawfile/assets/icon.png',
        },
      };
      const result = parseManifestToArrays(manifest, false);
      expect(result.copyFroms[0]).assertEqual('resources/rawfile/assets/icon.png');
    });

    it('handles null-ish from values', 0, () => {
      const manifest = {
        copies: {
          'assets/icon.png': null,
        },
      };
      const result = parseManifestToArrays(manifest as any, false);
      expect(result.copyFroms[0]).assertEqual('');
      expect(result.copyTos[0]).assertEqual('assets/icon.png');
    });
  });
}
