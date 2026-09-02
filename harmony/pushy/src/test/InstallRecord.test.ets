import { describe, it, expect } from '@ohos/hypium';
import {
  INSTALL_RECORD_FILE_NAME,
  INSTALL_RECORD_SCHEMA,
  STAGING_SUFFIX,
  buildInstallRecord,
  expectedBundleSha256ForActivation,
  isRecordForVersion,
  isReservedEntryName,
  parseInstallRecord,
  stagingDirectoryFor,
} from '../main/ets/InstallRecord';
import { ERROR_SWITCH_VERSION_FAILED, UpdateError } from '../main/ets/ErrorCodes';

// 两阶段安装的完成记录(cpp/patch_core/install_record.h 的 ArkTS 镜像):
// 纯逻辑部分,不碰磁盘。
export default function installRecordTest() {
  describe('InstallRecord.buildInstallRecord', () => {
    it('serializes schema, version and digests', 0, () => {
      const record = parseInstallRecord(
        buildInstallRecord('abc', 'BUNDLE', 'ARTIFACT'),
      );
      expect(record !== null).assertTrue();
      expect(record!.schema).assertEqual(INSTALL_RECORD_SCHEMA);
      expect(record!.versionHash).assertEqual('abc');
      expect(record!.bundleSha256).assertEqual('BUNDLE');
      expect(record!.artifactSha256).assertEqual('ARTIFACT');
    });

    it('omits empty digests', 0, () => {
      const record = parseInstallRecord(buildInstallRecord('abc', '', ''));
      expect(record !== null).assertTrue();
      expect(record!.bundleSha256 === undefined).assertTrue();
      expect(record!.artifactSha256 === undefined).assertTrue();
    });

    it('derives the staging directory from the version directory', 0, () => {
      expect(stagingDirectoryFor('/data/_update/abc')).assertEqual(
        `/data/_update/abc${STAGING_SUFFIX}`,
      );
    });
  });

  describe('InstallRecord.parseInstallRecord', () => {
    it('treats an empty file as a legacy record', 0, () => {
      const record = parseInstallRecord('');
      expect(record !== null).assertTrue();
      expect(Object.keys(record!).length).assertEqual(0);
    });

    it('parses a JSON object', 0, () => {
      const record = parseInstallRecord('{"schema":1,"versionHash":"abc"}');
      expect(record !== null).assertTrue();
      expect(record!.schema).assertEqual(1);
      expect(record!.versionHash).assertEqual('abc');
    });

    it('rejects malformed or non-object content', 0, () => {
      expect(parseInstallRecord('{oops')).assertNull();
      expect(parseInstallRecord('[1,2]')).assertNull();
      expect(parseInstallRecord('"text"')).assertNull();
      expect(parseInstallRecord('null')).assertNull();
    });
  });

  describe('InstallRecord.isRecordForVersion', () => {
    it('is false without a record', 0, () => {
      expect(isRecordForVersion(null, 'abc')).assertFalse();
    });

    it('trusts a legacy empty record', 0, () => {
      expect(isRecordForVersion({}, 'abc')).assertTrue();
    });

    it('requires the schema and version to match', 0, () => {
      const record = parseInstallRecord(buildInstallRecord('abc', '', ''));
      expect(isRecordForVersion(record, 'abc')).assertTrue();
      expect(isRecordForVersion(record, 'def')).assertFalse();
      expect(
        isRecordForVersion({ schema: INSTALL_RECORD_SCHEMA + 1, versionHash: 'abc' }, 'abc'),
      ).assertFalse();
    });
  });

  describe('InstallRecord.expectedBundleSha256ForActivation', () => {
    it('throws SWITCH_VERSION_FAILED without a record', 0, () => {
      let caught: UpdateError | null = null;
      try {
        expectedBundleSha256ForActivation(null, 'abc');
      } catch (e) {
        caught = e as UpdateError;
      }
      expect(caught !== null).assertTrue();
      expect(caught!.code).assertEqual(ERROR_SWITCH_VERSION_FAILED);
      expect(caught!.message.startsWith(`[${ERROR_SWITCH_VERSION_FAILED}] `)).assertTrue();
    });

    it('has nothing to verify for legacy or digest-less records', 0, () => {
      expect(expectedBundleSha256ForActivation({}, 'abc')).assertEqual('');
      expect(
        expectedBundleSha256ForActivation(
          parseInstallRecord(buildInstallRecord('abc', '', '')),
          'abc',
        ),
      ).assertEqual('');
    });

    it('returns the recorded digest for a matching record', 0, () => {
      expect(
        expectedBundleSha256ForActivation(
          parseInstallRecord(buildInstallRecord('abc', 'DIGEST', '')),
          'abc',
        ),
      ).assertEqual('DIGEST');
    });

    it('throws on a record for another version', 0, () => {
      let threw = false;
      try {
        expectedBundleSha256ForActivation(
          parseInstallRecord(buildInstallRecord('def', 'DIGEST', '')),
          'abc',
        );
      } catch (e) {
        threw = true;
      }
      expect(threw).assertTrue();
    });
  });

  describe('InstallRecord.isReservedEntryName', () => {
    it('reserves every .pushy- prefixed name', 0, () => {
      expect(isReservedEntryName(INSTALL_RECORD_FILE_NAME)).assertTrue();
      expect(isReservedEntryName('.pushy-anything')).assertTrue();
    });

    it('allows ordinary entries', 0, () => {
      expect(isReservedEntryName('bundle.harmony.js')).assertFalse();
      expect(isReservedEntryName('.pushyx')).assertFalse();
      expect(isReservedEntryName('pushy-complete')).assertFalse();
    });
  });
}
