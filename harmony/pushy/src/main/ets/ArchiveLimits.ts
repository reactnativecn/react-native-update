import fileIo from '@ohos.file.fs';
import statvfs from '@ohos.file.statvfs';

// ArkTS mirror of cpp/patch_core/archive_limits.h — keep in sync by hand.
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
    throw Error(`insufficient disk space: need ${needed} bytes, have ${free}`);
  }
}

export interface DirectoryMeasure {
  entries: number;
  bytes: number;
}

/**
 * 递归统计目录里的条目数与总字节数;两者任一超过上限立即抛错(不必扫完)。
 */
export async function measureExtractedDirectory(
  directory: string,
  acc: DirectoryMeasure = { entries: 0, bytes: 0 },
): Promise<DirectoryMeasure> {
  const names = (await fileIo.listFile(directory)).filter(
    name => name !== '.' && name !== '..',
  );
  for (const name of names) {
    const path = `${directory}/${name}`;
    const stat = await fileIo.stat(path);
    acc.entries += 1;
    if (acc.entries > MAX_ENTRIES) {
      throw Error(`archive has too many entries (> ${MAX_ENTRIES})`);
    }
    if (stat.isDirectory()) {
      await measureExtractedDirectory(path, acc);
      continue;
    }
    if (stat.size > MAX_ENTRY_BYTES) {
      throw Error(`archive entry too large: ${name} (${stat.size} bytes)`);
    }
    acc.bytes += stat.size;
    if (acc.bytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw Error(
        `archive expands beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`,
      );
    }
  }
  return acc;
}
