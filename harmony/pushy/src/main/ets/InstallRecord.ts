import fileIo from '@ohos.file.fs';
import { util } from '@kit.ArkTS';
import NativePatchCore from './NativePatchCore';
import { ERROR_SWITCH_VERSION_FAILED, createUpdateError } from './ErrorCodes';

// ArkTS mirror of cpp/patch_core/install_record.h — keep in sync by hand
// (harmony/pushy/src/test/check-constant-parity.js asserts the values match).
// 两阶段安装的完成记录:作为安装最后一步写进 staging 目录,随后 staging
// 原子 rename 成版本目录;激活前重新校验 bundle 摘要。空文件 = 旧版 SDK
// 写的历史标记,仍视为完整安装(无摘要可验)。
export const INSTALL_RECORD_SCHEMA = 1;
export const INSTALL_RECORD_FILE_NAME = '.pushy-complete';
export const STAGING_SUFFIX = '.staging';
// 归档不得携带任何 `.pushy-` 前缀的条目(任意深度):这些名字保留给 SDK 自己
// 写的记录,与 Android 的规则一致。
export const RESERVED_ENTRY_PREFIX = '.pushy-';
export const HARMONY_BUNDLE_FILE_NAME = 'bundle.harmony.js';

export interface InstallRecordData {
  schema?: number;
  versionHash?: string;
  bundleSha256?: string;
  artifactSha256?: string;
}

export function stagingDirectoryFor(versionDir: string): string {
  return `${versionDir}${STAGING_SUFFIX}`;
}

export function isReservedEntryName(name: string): boolean {
  return name.startsWith(RESERVED_ENTRY_PREFIX);
}

export function buildInstallRecord(
  versionHash: string,
  bundleSha256: string,
  artifactSha256: string,
): string {
  const record: InstallRecordData = {
    schema: INSTALL_RECORD_SCHEMA,
    versionHash,
  };
  if (bundleSha256) {
    record.bundleSha256 = bundleSha256;
  }
  if (artifactSha256) {
    record.artifactSha256 = artifactSha256;
  }
  return JSON.stringify(record);
}

/** 写入并 fsync:紧随其后的 rename 必须能在盘上看到它。 */
export async function writeInstallRecord(
  versionDir: string,
  recordJson: string,
): Promise<void> {
  const path = `${versionDir}/${INSTALL_RECORD_FILE_NAME}`;
  if (fileIo.accessSync(path)) {
    await fileIo.unlink(path);
  }
  const file = await fileIo.open(
    path,
    fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
  );
  try {
    const bytes = new util.TextEncoder().encodeInto(recordJson);
    await fileIo.write(file.fd, bytes.buffer as ArrayBuffer);
    await fileIo.fsync(file.fd);
  } finally {
    await fileIo.close(file);
  }
}

/**
 * 解析记录文本:空串(历史标记)返回 {};畸形/非对象返回 null。纯函数,
 * 供 readInstallRecord 与单测共用。
 */
export function parseInstallRecord(text: string): InstallRecordData | null {
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as InstallRecordData | null;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (e) {
    return null;
  }
}

/**
 * 读取记录:文件缺失/畸形返回 null;空文件(历史标记)返回 {}。
 */
export function readInstallRecord(versionDir: string): InstallRecordData | null {
  const path = `${versionDir}/${INSTALL_RECORD_FILE_NAME}`;
  if (!fileIo.accessSync(path)) {
    return null;
  }
  try {
    const stat = fileIo.statSync(path);
    if (stat.size === 0) {
      return {};
    }
    if (stat.size > 64 * 1024) {
      return null;
    }
    return parseInstallRecord(fileIo.readTextSync(path));
  } catch (e) {
    return null;
  }
}

/** 记录是否宣告本版本完整安装(历史空记录视为是)。纯函数。 */
export function isRecordForVersion(
  record: InstallRecordData | null,
  versionHash: string,
): boolean {
  if (record === null) {
    return false;
  }
  if (Object.keys(record).length === 0) {
    return true;
  }
  return (
    record.schema === INSTALL_RECORD_SCHEMA && record.versionHash === versionHash
  );
}

/** 存在性判定(启动/去重路径,不算摘要):记录存在且(非历史空文件时)指向本版本。 */
export function isInstallComplete(versionDir: string, versionHash: string): boolean {
  return isRecordForVersion(readInstallRecord(versionDir), versionHash);
}

/**
 * 激活前的记录校验(不含摘要):返回需要复核的 bundle 摘要,历史空记录或
 * 无摘要记录返回空串;记录缺失/不符抛 SWITCH_VERSION_FAILED。纯函数。
 */
export function expectedBundleSha256ForActivation(
  record: InstallRecordData | null,
  versionHash: string,
): string {
  if (record === null) {
    throw createUpdateError(
      ERROR_SWITCH_VERSION_FAILED,
      `Bundle version ${versionHash} has no valid completion record.`,
    );
  }
  if (Object.keys(record).length === 0) {
    return '';
  }
  if (
    record.schema !== INSTALL_RECORD_SCHEMA ||
    record.versionHash !== versionHash
  ) {
    throw createUpdateError(
      ERROR_SWITCH_VERSION_FAILED,
      `Bundle version ${versionHash} completion record mismatch.`,
    );
  }
  return record.bundleSha256 ?? '';
}

/**
 * 激活前校验:记录带摘要时在 native 工作线程重新计算 bundle 摘要(整包
 * 几十 MB,不能在 UI 线程同步算);不通过则抛错说明原因。
 */
export async function verifyInstallForActivation(
  versionDir: string,
  versionHash: string,
  bundlePath: string,
): Promise<void> {
  const expected = expectedBundleSha256ForActivation(
    readInstallRecord(versionDir),
    versionHash,
  );
  if (!expected) {
    return;
  }
  const actual = await NativePatchCore.sha256HexFileAsync(bundlePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw createUpdateError(
      ERROR_SWITCH_VERSION_FAILED,
      `Bundle version ${versionHash} bundle digest mismatch.`,
    );
  }
}
