import fileIo from '@ohos.file.fs';
import { util } from '@kit.ArkTS';
import NativePatchCore from './NativePatchCore';

// ArkTS mirror of cpp/patch_core/install_record.h — keep in sync by hand.
// 两阶段安装的完成记录:作为安装最后一步写进 staging 目录,随后 staging
// 原子 rename 成版本目录;激活前重新校验 bundle 摘要。空文件 = 旧版 SDK
// 写的历史标记,仍视为完整安装(无摘要可验)。
export const INSTALL_RECORD_SCHEMA = 1;
export const INSTALL_RECORD_FILE_NAME = '.pushy-complete';
export const STAGING_SUFFIX = '.staging';
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
 * 解析记录:文件缺失/畸形返回 null;空文件(历史标记)返回 {}。
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
    const text = fileIo.readTextSync(path);
    const parsed = JSON.parse(text) as InstallRecordData | null;
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

/** 存在性判定(启动/去重路径,不算摘要):记录存在且(非历史空文件时)指向本版本。 */
export function isInstallComplete(versionDir: string, versionHash: string): boolean {
  const record = readInstallRecord(versionDir);
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

/** 激活前校验:记录带摘要时重新计算 bundle 摘要;不通过则抛错说明原因。 */
export function verifyInstallForActivation(
  versionDir: string,
  versionHash: string,
  bundlePath: string,
): void {
  const record = readInstallRecord(versionDir);
  if (record === null) {
    throw Error(`Bundle version ${versionHash} has no valid completion record.`);
  }
  if (Object.keys(record).length === 0) {
    return;
  }
  if (
    record.schema !== INSTALL_RECORD_SCHEMA ||
    record.versionHash !== versionHash
  ) {
    throw Error(`Bundle version ${versionHash} completion record mismatch.`);
  }
  if (!record.bundleSha256) {
    return;
  }
  const actual = NativePatchCore.sha256HexFile(bundlePath);
  if (actual.toLowerCase() !== record.bundleSha256.toLowerCase()) {
    throw Error(`Bundle version ${versionHash} bundle digest mismatch.`);
  }
}
