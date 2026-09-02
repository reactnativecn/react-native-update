import fileIo from '@ohos.file.fs';
import statvfs from '@ohos.file.statvfs';
import {
  ERROR_FILE_OPERATION_FAILED,
  ERROR_PATCH_FAILED,
  createUpdateError,
} from './ErrorCodes';
import { isReservedEntryName } from './InstallRecord';

// ArkTS mirror of cpp/patch_core/archive_limits.h — keep in sync by hand
// (harmony/pushy/src/test/check-constant-parity.js asserts the values match).
// 损坏或恶意更新包的伤害上限:最多耗费有限的磁盘/内存/时间,绝不撑爆磁盘。
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 2048 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRIES = 20000;
export const MAX_COMPRESSION_RATIO = 100;
export const RATIO_CHECK_MIN_BYTES = 1 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const FREE_DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * 解压前的总量校验(zlib.getOriginalSize 给出的归档解压后总字节数)。
 * zlib.decompressFile 没有逐条钩子,C++ 头文件里的逐条压缩比在这里只能按
 * 整包近似:总解压量超过上限、或(总量大于 RATIO_CHECK_MIN_BYTES 时)总压缩
 * 比超过 MAX_COMPRESSION_RATIO 即拒绝——20MB 归档 100:1 的 2GB 载荷在解压前
 * 就被挡下,而不是先解出来再量。
 */
export function checkUncompressedSize(
  archiveBytes: number,
  uncompressedBytes: number,
): void {
  if (uncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw createUpdateError(
      ERROR_PATCH_FAILED,
      `archive expands beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes ` +
        `(${uncompressedBytes})`,
    );
  }
  if (
    uncompressedBytes > RATIO_CHECK_MIN_BYTES &&
    archiveBytes > 0 &&
    uncompressedBytes > archiveBytes * MAX_COMPRESSION_RATIO
  ) {
    throw createUpdateError(
      ERROR_PATCH_FAILED,
      `archive compression ratio exceeds ${MAX_COMPRESSION_RATIO}:1 ` +
        `(${uncompressedBytes}/${archiveBytes})`,
    );
  }
}

/**
 * 目标所在文件系统必须还能再写 bytesToWrite + 安全余量。取不到可用空间
 * (返回 0/异常)视为未知,放行。
 */
export async function ensureFreeSpace(
  target: string,
  bytesToWrite: number,
): Promise<void> {
  let probe = target;
  while (probe.length > 1 && !fileIo.accessSync(probe)) {
    const slash = probe.lastIndexOf('/');
    if (slash <= 0) {
      return;
    }
    probe = probe.substring(0, slash);
  }
  let free = 0;
  try {
    free = await statvfs.getFreeSize(probe);
  } catch (e) {
    return;
  }
  if (free <= 0) {
    return;
  }
  const needed = Math.max(0, bytesToWrite) + FREE_DISK_MARGIN_BYTES;
  if (free < needed) {
    throw createUpdateError(
      ERROR_FILE_OPERATION_FAILED,
      `insufficient disk space: need ${needed} bytes, have ${free}`,
    );
  }
}

export interface DirectoryMeasure {
  entries: number;
  bytes: number;
}

/**
 * 递归统计目录里的条目数与总字节数;两者任一超过上限立即抛错(不必扫完)。
 * 同一趟遍历里拒绝任意深度的 `.pushy-` 保留条目(完成记录只能由 SDK 写)。
 */
export async function measureExtractedDirectory(
  directory: string,
  acc: DirectoryMeasure = { entries: 0, bytes: 0 },
): Promise<DirectoryMeasure> {
  const names = (await fileIo.listFile(directory)).filter(
    name => name !== '.' && name !== '..',
  );
  for (const name of names) {
    if (isReservedEntryName(name)) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `archive contains reserved entry ${name}`,
      );
    }
    const path = `${directory}/${name}`;
    const stat = await fileIo.stat(path);
    acc.entries += 1;
    if (acc.entries > MAX_ENTRIES) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `archive has too many entries (> ${MAX_ENTRIES})`,
      );
    }
    if (stat.isDirectory()) {
      await measureExtractedDirectory(path, acc);
      continue;
    }
    if (stat.size > MAX_ENTRY_BYTES) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `archive entry too large: ${name} (${stat.size} bytes)`,
      );
    }
    acc.bytes += stat.size;
    if (acc.bytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `archive expands beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`,
      );
    }
  }
  return acc;
}
