import http from '@ohos.net.http';
import fileIo from '@ohos.file.fs';
import common from '@ohos.app.ability.common';
import { zlib } from '@kit.BasicServicesKit';
import { EventHub } from './EventHub';
import { DownloadTaskParams } from './DownloadTaskParams';
import { saveFileToSandbox } from './SaveFile';
import { util } from '@kit.ArkTS';
import NativePatchCore, {
  ARCHIVE_PATCH_TYPE_FROM_PACKAGE,
  ARCHIVE_PATCH_TYPE_FROM_PPK,
  CopyGroupResult,
} from './NativePatchCore';
import { monotonicNowMs } from './MonotonicClock';
import logger from './Logger';
import {
  MAX_ARCHIVE_BYTES,
  MAX_MANIFEST_BYTES,
  UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES,
  checkUncompressedSize,
  ensureFreeSpace,
  measureExtractedDirectory,
} from './ArchiveLimits';
import {
  HARMONY_BUNDLE_FILE_NAME,
  buildInstallRecord,
  stagingDirectoryFor,
  writeInstallRecord,
} from './InstallRecord';
import {
  ERROR_DOWNLOAD_FAILED,
  ERROR_FILE_OPERATION_FAILED,
  ERROR_INVALID_OPTIONS,
  ERROR_PATCH_FAILED,
  createUpdateError,
  getErrorMessage,
  toUpdateError,
} from './ErrorCodes';

const TAG = 'DownloadTask';

export interface PatchManifestArrays {
  copyFroms: string[];
  copyTos: string[];
  // 与 copyFroms/copyTos 逐位对齐的 copiesCrc(CLI >= 2.21.2 的 pdiff
  // manifest 携带,键是 to);无声明时为 null。拷贝前用它校验包内资源内容,
  // 不符则整次 patch 失败落 full——重打包二进制不能静默拷出漂移的资源。
  copyCrcs: (number | null)[];
  deletes: string[];
  // __diff.json 中对应 bundle patch 条目的 hbcTransform 元数据(原始 JSON
  // 字符串);为空时 native 走现状路径
  hbcTransformMeta: string;
}

export function parseManifestToArrays(
  manifest: Record<string, any>,
  normalizeResourceCopies: boolean,
): PatchManifestArrays {
  const copyFroms: string[] = [];
  const copyTos: string[] = [];
  const copyCrcs: (number | null)[] = [];
  const deletesValue = manifest.deletes;
  const deletes = Array.isArray(deletesValue)
    ? deletesValue.map(item => String(item))
    : deletesValue && typeof deletesValue === 'object'
      ? Object.keys(deletesValue)
      : [];

  const copies = (manifest.copies || {}) as Record<string, string>;
  const copiesCrcValue = manifest.copiesCrc;
  const copiesCrc =
    copiesCrcValue && typeof copiesCrcValue === 'object'
      ? (copiesCrcValue as Record<string, number>)
      : ({} as Record<string, number>);
  for (const to of Object.keys(copies)) {
    const rawFrom = copies[to];
    let from = String(rawFrom || '');
    if (normalizeResourceCopies) {
      from = from.replace('resources/rawfile/', '');
      if (!from) {
        from = to;
      }
    }
    copyFroms.push(from);
    copyTos.push(to);
    const crc = copiesCrc[to];
    copyCrcs.push(typeof crc === 'number' && Number.isFinite(crc) ? crc : null);
  }

  const hbcTransform = manifest.hbcTransform as
    | Record<string, object>
    | undefined;
  const hbcTransformEntry =
    hbcTransform && typeof hbcTransform === 'object'
      ? hbcTransform[HARMONY_BUNDLE_PATCH_ENTRY]
      : undefined;
  const hbcTransformMeta =
    hbcTransformEntry && typeof hbcTransformEntry === 'object'
      ? JSON.stringify(hbcTransformEntry)
      : '';

  return {
    copyFroms,
    copyTos,
    copyCrcs,
    deletes,
    hbcTransformMeta,
  };
}

interface PatchInputs {
  entryNames: string[];
  manifestArrays: PatchManifestArrays;
}

function toArrayBufferSlice(
  payload: Uint8Array,
  offset: number,
  length: number,
): ArrayBuffer {
  return (payload.buffer as ArrayBuffer).slice(
    payload.byteOffset + offset,
    payload.byteOffset + offset + length,
  );
}

const DIFF_MANIFEST_ENTRY = '__diff.json';
const HARMONY_BUNDLE_PATCH_ENTRY = 'bundle.harmony.js.patch';
const TEMP_ORIGIN_BUNDLE_ENTRY = '.origin.bundle.harmony.js';
const FILE_COPY_BUFFER_SIZE = 64 * 1024;
const DOWNLOAD_CALL_TIMEOUT_MS = 10 * 60 * 1000;

// 断点续传 sidecar(NATIVE_CHECKUPDATE_DESIGN §11.4):记录 partial 属于
// 哪个 url、验证器与总长。归档与 sidecar 同生共死;有归档无 sidecar(或
// url 不符)一律视为不可信,删掉重来。
interface ResumeMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  total?: number;
}

// "bytes <start>-<end>/<total>"。返回总长(“*”记 0);缺失/畸形/起点与
// 本地 partial 不符、或 range 与 total 自相矛盾(end 在 start 之前、数值
// total 不大于 end)返回 -1——那样追加的字节不可信。RFC 9110 §14.4 要求
// 完整长度必须大于 last-pos。
export function parseContentRangeTotal(
  header: string,
  expectedStart: number,
): number {
  if (!header.startsWith('bytes ')) {
    return -1;
  }
  const range = header.substring('bytes '.length).trim();
  const slash = range.indexOf('/');
  const dash = range.indexOf('-');
  if (slash < 0 || dash < 0 || dash > slash) {
    return -1;
  }
  const start = parseInt(range.substring(0, dash).trim(), 10);
  const end = parseInt(range.substring(dash + 1, slash).trim(), 10);
  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start !== expectedStart ||
    end < start
  ) {
    return -1;
  }
  const totalPart = range.substring(slash + 1).trim();
  if (totalPart === '*') {
    return 0;
  }
  const total = parseInt(totalPart, 10);
  return Number.isNaN(total) || total <= end ? -1 : total;
}

export class DownloadTask {
  private context: common.Context;
  private hash = '';
  private eventHub: EventHub;
  // 一经 downloadFile 正常返回即置位:之后的失败是 patch 应用失败,归档
  // 已被判定有毒,清理时必须连 sidecar 一起删,绝不能续传进同一个失败。
  private downloadPhaseCompleted = false;
  // 下载归档的 SHA-256,解压前计算,写进完成记录。
  private artifactSha256 = '';

  // 两阶段安装(cpp/patch_core/install_record.h):解压/打补丁全部在
  // <hash>.staging 里进行,写完完成记录后一次 rename 成 <hash>;失败或崩溃
  // 都不会留下一个"看起来像版本"的半成品目录。
  private stagingDirectory(params: DownloadTaskParams): string {
    return stagingDirectoryFor(params.unzipDirectory);
  }

  private async promoteStaging(params: DownloadTaskParams): Promise<void> {
    const work = this.stagingDirectory(params);
    const bundlePath = `${work}/${HARMONY_BUNDLE_FILE_NAME}`;
    if (!fileIo.accessSync(bundlePath)) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `bundle missing after install: ${bundlePath}`,
      );
    }
    // 整 bundle 几十 MB:摘要在 native 工作线程算,不冻结 UI 线程。
    const bundleSha256 = await NativePatchCore.sha256HexFileAsync(bundlePath);
    await writeInstallRecord(
      work,
      buildInstallRecord(params.hash, bundleSha256, this.artifactSha256),
    );
    if (fileIo.accessSync(params.unzipDirectory)) {
      await this.removeDirectory(params.unzipDirectory);
    }
    await fileIo.rename(work, params.unzipDirectory);
  }

  constructor(context: common.Context) {
    this.context = context;
    this.eventHub = EventHub.getInstance();
  }

  private resumeSidecarPath(targetFile: string): string {
    return `${targetFile}.resume`;
  }

  private async readResumeMeta(
    targetFile: string,
    url: string,
  ): Promise<ResumeMeta | null> {
    const sidecar = this.resumeSidecarPath(targetFile);
    if (!fileIo.accessSync(sidecar)) {
      return null;
    }
    try {
      const meta = this.parseJsonEntry(
        await this.readFileContent(sidecar),
      ) as ResumeMeta;
      if (meta && meta.url === url) {
        return meta;
      }
    } catch (e) {
      // 坏 sidecar 只意味着“无法续传”。
    }
    return null;
  }

  private async writeResumeMeta(
    targetFile: string,
    meta: ResumeMeta,
  ): Promise<void> {
    try {
      const encoded = new util.TextEncoder().encodeInto(JSON.stringify(meta));
      await this.writeFileContent(this.resumeSidecarPath(targetFile), encoded);
    } catch (e) {
      // 非致命:没有 sidecar,下次从零开始。
      logger.error(TAG, `Failed to persist resume sidecar: ${getErrorMessage(e)}`);
    }
  }

  private async deleteResumeSidecar(targetFile: string): Promise<void> {
    try {
      const sidecar = this.resumeSidecarPath(targetFile);
      if (fileIo.accessSync(sidecar)) {
        await fileIo.unlink(sidecar);
      }
    } catch (e) {
      logger.error(TAG, `Failed to delete resume sidecar: ${getErrorMessage(e)}`);
    }
  }

  // 归档连同 sidecar 一起删除(被消费或被判定有毒)。
  private async deleteArchiveAndSidecar(targetFile: string): Promise<void> {
    try {
      if (fileIo.accessSync(targetFile)) {
        await fileIo.unlink(targetFile);
      }
    } catch (e) {
      logger.error(TAG, `Failed to delete archive: ${getErrorMessage(e)}`);
    }
    await this.deleteResumeSidecar(targetFile);
  }

  // fileIo.rmdir 本身递归删除整个目录树;文件走 unlink。
  private async removeDirectory(path: string): Promise<void> {
    try {
      if (!fileIo.accessSync(path)) {
        return;
      }
      const stat = await fileIo.stat(path);
      if (stat.isDirectory()) {
        await fileIo.rmdir(path);
      } else {
        await fileIo.unlink(path);
      }
    } catch (error) {
      logger.error(TAG, `Failed to delete ${path}: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_FILE_OPERATION_FAILED);
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!path || fileIo.accessSync(path)) {
      return;
    }

    const parentPath = path.substring(0, path.lastIndexOf('/'));
    if (parentPath && parentPath !== path) {
      await this.ensureDirectory(parentPath);
    }

    if (!fileIo.accessSync(path)) {
      try {
        await fileIo.mkdir(path);
      } catch (error) {
        if (!fileIo.accessSync(path)) {
          throw error;
        }
      }
    }
  }

  private async ensureParentDirectory(filePath: string): Promise<void> {
    const parentPath = filePath.substring(0, filePath.lastIndexOf('/'));
    if (!parentPath) {
      return;
    }
    await this.ensureDirectory(parentPath);
  }

  /**
   * 解压前读取归档解压后的总字节数(zlib.getOriginalSize,API 12——RNOH 的
   * 最低 API 已覆盖)。读不到就拒绝归档:zlib.decompressFile 没有逐条钩子,
   * 不知道展开量就放行等于允许一个 20MB 的归档在 measureExtractedDirectory
   * 跑到之前先把磁盘写满。
   */
  private async readOriginalSize(archiveFile: string): Promise<number> {
    let size: number | undefined;
    try {
      size = await zlib.getOriginalSize(archiveFile);
    } catch (e) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `cannot determine archive expansion size: ${getErrorMessage(e)}`,
      );
    }
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `cannot determine archive expansion size: ${String(size)}`,
      );
    }
    return size;
  }

  /**
   * 解压 + 资源上限(cpp/patch_core/archive_limits.h)。zlib.decompressFile
   * 没有逐条钩子:解压前用 getOriginalSize 把总解压量与整包压缩比挡在
   * 上限内(20MB 归档 100:1 的 2GB 载荷不会先解出来再量),按已知解压量查
   * 磁盘,解压量未知直接拒绝;解压后再统计条目数/单条大小/总字节数并拒绝
   * 任意深度的 `.pushy-` 保留条目(超限即失败,staging 目录由失败清理删除)。
   */
  private async extractArchive(
    archiveFile: string,
    unzipDirectory: string,
  ): Promise<void> {
    const archiveStat = await fileIo.stat(archiveFile);
    if (archiveStat.size > MAX_ARCHIVE_BYTES) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `archive too large: ${archiveStat.size} bytes`,
      );
    }
    const originalSize = await this.readOriginalSize(archiveFile);
    checkUncompressedSize(archiveStat.size, originalSize);
    await ensureFreeSpace(unzipDirectory, originalSize);
    try {
      await zlib.decompressFile(archiveFile, unzipDirectory);
    } catch (e) {
      throw toUpdateError(e, ERROR_PATCH_FAILED);
    }
    await measureExtractedDirectory(unzipDirectory);
  }

  private async recreateDirectory(path: string): Promise<void> {
    await this.removeDirectory(path);
    await this.ensureDirectory(path);
  }

  private async readFileContent(filePath: string): Promise<ArrayBuffer> {
    const stat = await fileIo.stat(filePath);
    const reader = await fileIo.open(filePath, fileIo.OpenMode.READ_ONLY);
    const content = new ArrayBuffer(stat.size);

    try {
      await fileIo.read(reader.fd, content);
      return content;
    } finally {
      await fileIo.close(reader);
    }
  }

  private async listEntryNames(directory: string): Promise<string[]> {
    const files = await fileIo.listFile(directory);
    const validFiles = files.filter(file => file !== '.' && file !== '..');

    const stats = await Promise.all(
      validFiles.map(file => fileIo.stat(`${directory}/${file}`)),
    );

    return validFiles.filter((_, index) => !stats[index].isDirectory());
  }

  private async writeFileContent(
    targetFile: string,
    content: ArrayBuffer | Uint8Array,
  ): Promise<void> {
    const payload =
      content instanceof Uint8Array ? content : new Uint8Array(content);
    await this.ensureParentDirectory(targetFile);
    if (fileIo.accessSync(targetFile)) {
      await fileIo.unlink(targetFile);
    }

    let writer: fileIo.File | null = null;
    try {
      writer = await fileIo.open(
        targetFile,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
      );
      const chunkSize = FILE_COPY_BUFFER_SIZE;
      let bytesWritten = 0;

      while (bytesWritten < payload.byteLength) {
        const chunkLength = Math.min(
          chunkSize,
          payload.byteLength - bytesWritten,
        );
        const chunk = toArrayBufferSlice(payload, bytesWritten, chunkLength);
        await fileIo.write(writer.fd, chunk);
        bytesWritten += chunkLength;
      }
    } finally {
      if (writer) {
        await fileIo.close(writer);
      }
    }
  }

  private parseJsonEntry(content: ArrayBuffer): Record<string, any> {
    return JSON.parse(
      new util.TextDecoder().decodeToString(new Uint8Array(content)),
    ) as Record<string, any>;
  }

  private async readManifestArrays(
    directory: string,
    normalizeResourceCopies: boolean,
  ): Promise<PatchManifestArrays> {
    const manifestPath = `${directory}/${DIFF_MANIFEST_ENTRY}`;
    if (!fileIo.accessSync(manifestPath)) {
      return {
        copyFroms: [],
        copyTos: [],
        copyCrcs: [],
        deletes: [],
        hbcTransformMeta: '',
      };
    }

    const manifestStat = await fileIo.stat(manifestPath);
    if (manifestStat.size > MAX_MANIFEST_BYTES) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `patch manifest too large: ${manifestStat.size} bytes`,
      );
    }
    return parseManifestToArrays(
      this.parseJsonEntry(await this.readFileContent(manifestPath)),
      normalizeResourceCopies,
    );
  }


  private async applyBundlePatchFromFileSource(
    originContent: ArrayBuffer,
    workingDirectory: string,
    bundlePatchPath: string,
    outputFile: string,
    hbcTransformMeta = '',
  ): Promise<void> {
    const originBundlePath = `${workingDirectory}/${TEMP_ORIGIN_BUNDLE_ENTRY}`;
    try {
      await this.writeFileContent(originBundlePath, originContent);
      await NativePatchCore.applyPatchFromFileSource({
        copyFroms: [],
        copyTos: [],
        deletes: [],
        sourceRoot: workingDirectory,
        targetRoot: workingDirectory,
        originBundlePath,
        bundlePatchPath,
        bundleOutputPath: outputFile,
        enableMerge: false,
        bundleHbcTransformMeta: hbcTransformMeta,
      });
    } catch (error) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `Failed to process bundle patch: ${getErrorMessage(error)}`,
      );
    } finally {
      if (fileIo.accessSync(originBundlePath)) {
        await fileIo.unlink(originBundlePath);
      }
    }
  }

  private async copySandboxFile(
    sourceFile: string,
    targetFile: string,
  ): Promise<void> {
    let reader: fileIo.File | null = null;
    let writer: fileIo.File | null = null;
    const buffer = new ArrayBuffer(FILE_COPY_BUFFER_SIZE);
    let offset = 0;

    try {
      reader = await fileIo.open(sourceFile, fileIo.OpenMode.READ_ONLY);
      await this.ensureParentDirectory(targetFile);
      if (fileIo.accessSync(targetFile)) {
        await fileIo.unlink(targetFile);
      }
      writer = await fileIo.open(
        targetFile,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
      );

      while (true) {
        const readLength = await fileIo.read(reader.fd, buffer, {
          offset,
          length: FILE_COPY_BUFFER_SIZE,
        });
        if (readLength <= 0) {
          break;
        }

        await fileIo.write(writer.fd, buffer.slice(0, readLength));
        offset += readLength;

        if (readLength < FILE_COPY_BUFFER_SIZE) {
          break;
        }
      }
    } finally {
      if (reader) {
        await fileIo.close(reader);
      }
      if (writer) {
        await fileIo.close(writer);
      }
    }
  }

  private async downloadFile(params: DownloadTaskParams): Promise<void> {
    this.hash = params.hash;
    // 跨启动断点续传(§11.4):砖机每次启动只有几百毫秒,每个已到手的字节
    // 都必须在进程死亡后仍然算数、单调累积。
    const outcome = await this.transferArchive(params, true);
    if (outcome === 'staleRange') {
      // 416 且本地 partial 与服务端不再匹配:删掉重来,仅此一次。
      await this.deleteArchiveAndSidecar(params.targetFile);
      const retry = await this.transferArchive(params, false);
      if (retry !== 'done') {
        throw createUpdateError(
          ERROR_DOWNLOAD_FAILED,
          `Server rejected the download range for ${params.url}`,
        );
      }
    }
    this.downloadPhaseCompleted = true;
  }

  private async transferArchive(
    params: DownloadTaskParams,
    allowResume: boolean,
  ): Promise<'done' | 'staleRange'> {
    const httpRequest = http.createHttp();
    let writer: fileIo.File | null = null;
    let contentLength = 0; // 本次响应体长度(206 时是剩余部分)
    let totalAll = 0; // 整个文件的总长(0 = 未知)
    let baseOffset = 0; // 响应许可的续传起点
    let received = 0;
    let writeError: Error | null = null;
    let writeQueue = Promise.resolve();
    let lastReportedPercentage = -1;
    let lastReportedBytes = 0;
    let etagHeader = '';
    let lastModifiedHeader = '';
    let contentRangeHeader = '';
    let contentEncodingHeader = '';
    // headersReceive 与 requestInStream promise 的先后顺序平台不保证;
    // 依赖 Content-Range 的续传路径必须显式等到响应头到达。
    let headersResolve: (() => void) | null = null;
    const headersPromise = new Promise<void>(resolve => {
      headersResolve = resolve;
    });
    const deadlineUptimeMs = params.deadlineUptimeMs > 0
      ? params.deadlineUptimeMs
      : monotonicNowMs() + DOWNLOAD_CALL_TIMEOUT_MS;
    if (deadlineUptimeMs <= monotonicNowMs()) {
      throw createUpdateError(
        ERROR_DOWNLOAD_FAILED,
        'Download deadline expired before start',
      );
    }

    // 续传状态盘点:有匹配的 sidecar 且 partial 未收齐才发 Range。
    let resumeMeta: ResumeMeta | null = allowResume
      ? await this.readResumeMeta(params.targetFile, params.url)
      : null;
    let resumeOffset = 0;
    if (resumeMeta && fileIo.accessSync(params.targetFile)) {
      const stat = await fileIo.stat(params.targetFile);
      const knownTotal = resumeMeta.total ?? 0;
      if (stat.size > 0 && knownTotal > 0 && stat.size === knownTotal) {
        // 上次尝试已收齐(进程死在下载结束与解压之间):无需再传。
        httpRequest.destroy();
        this.onProgressUpdate(knownTotal, knownTotal);
        return 'done';
      }
      if (stat.size > 0 && (knownTotal <= 0 || stat.size < knownTotal)) {
        resumeOffset = stat.size;
      }
    }
    if (resumeOffset === 0) {
      if (fileIo.accessSync(params.targetFile)) {
        await fileIo.unlink(params.targetFile);
      } else {
        await this.ensureParentDirectory(params.targetFile);
      }
      await this.deleteResumeSidecar(params.targetFile);
      resumeMeta = null;
    }

    // 响应体在状态码判定前一律只进内存缓冲:416/5xx 的错误体若被追加进
    // partial,续传状态就永久污染了。requestInStream 的 promise 在响应头
    // 到达时解决,缓冲窗口只有头与首批数据之间的间隙。
    let pendingChunks: ArrayBuffer[] | null = [];
    let discardBody = false;
    let authorize: (() => void) | null = null;
    const authorization = new Promise<void>(resolve => {
      authorize = resolve;
    });

    const reportProgress = () => {
      const overall = baseOffset + received;
      const overallTotal = totalAll > 0
        ? totalAll
        : contentLength > 0
          ? baseOffset + contentLength
          : 0;
      if (overallTotal > 0) {
        const percentage = Math.round((overall * 100) / overallTotal);
        if (percentage <= lastReportedPercentage) {
          return;
        }
        lastReportedPercentage = percentage;
      } else if (overall - lastReportedBytes < 256 * 1024) {
        return;
      } else {
        lastReportedBytes = overall;
      }
      this.onProgressUpdate(overall, overallTotal);
    };

    const closeWriter = async () => {
      if (writer) {
        await fileIo.close(writer);
        writer = null;
      }
    };

    let nextFreeSpaceProbeAt = 0;
    const enqueueWrite = (data: ArrayBuffer) => {
      received += data.byteLength;
      if (!writeError && baseOffset + received > MAX_ARCHIVE_BYTES) {
        // 未知长度/分块传输的兜底:超过上限即停写,请求在下面结算时失败。
        writeError = createUpdateError(
          ERROR_PATCH_FAILED,
          `archive too large: exceeded ${MAX_ARCHIVE_BYTES}`,
        );
      }
      // 未知长度:响应到达时只能预留安全余量,所以首次写入前探测一次,之后
      // 每写满 PROBE 字节再探测,每次都预留接下来的 PROBE 字节——两次探测之间
      // 的写入永远吃不到余量(归档上限本身远大于余量)。失败保留 partial 供
      // 下次续传。
      const writtenBefore = received - data.byteLength;
      const probeFreeSpace =
        totalAll <= 0 && writtenBefore >= nextFreeSpaceProbeAt;
      if (probeFreeSpace) {
        nextFreeSpaceProbeAt =
          writtenBefore + UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES;
      }
      writeQueue = writeQueue.then(async () => {
        if (!writer || writeError) {
          return;
        }
        try {
          if (probeFreeSpace) {
            await ensureFreeSpace(
              params.targetFile,
              UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES,
            );
          }
          await fileIo.write(writer.fd, data);
        } catch (error) {
          writeError = error as Error;
        }
      });
    };

    // Watchdog: reject the download if no data is received for a while, so a
    // stalled transfer after requestInStream resolves cannot hang the download
    // Promise (and the JS caller) forever.
    const INACTIVITY_TIMEOUT_MS = 60000;
    let watchdogTimer: number | null = null;
    let deadlineTimer: number | null = null;
    let inactivityReject: ((error: Error) => void) | null = null;
    const clearWatchdog = () => {
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };
    const refreshWatchdog = () => {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        if (inactivityReject) {
          inactivityReject(
            createUpdateError(
              ERROR_DOWNLOAD_FAILED,
              `Download stalled: no data received for ${INACTIVITY_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, INACTIVITY_TIMEOUT_MS);
    };
    const inactivityPromise = new Promise<void>((_, reject) => {
      inactivityReject = reject;
    });

    const dataEndPromise = new Promise<void>((resolve, reject) => {
      httpRequest.on('dataEnd', () => {
        clearWatchdog();
        // dataEnd 可能先于状态码判定到达(小响应):flush 必须等鉴权,
        // 否则缓冲中的字节还没进 writeQueue 就被当成“全部写完”。
        authorization
          .then(() => writeQueue)
          .then(async () => {
            if (writeError) {
              throw writeError;
            }
            await closeWriter();
            resolve();
          })
          .catch(async error => {
            // reject 必须先于 closeWriter：此时 watchdog 已清除，若 close
            // 也失败（同一磁盘故障的常见连锁）而 reject 未执行，下载 Promise
            // 将永久挂起——正是 HM-2 要消灭的症状。
            reject(error);
            try {
              await closeWriter();
            } catch (closeErr) {
              logger.error(
                TAG,
                `closeWriter failed after write error: ${getErrorMessage(closeErr)}`,
              );
            }
          });
      });
    });
    // 下面的 race 可能在 dataEnd 到来之前就以 deadline/inactivity 结束,此时
    // dataEndPromise 的 reject 没有订阅者——标记为已处理,避免 unhandled
    // rejection;真正的错误已经由 race 抛出。
    dataEndPromise.catch(() => {});

    try {
      httpRequest.on('headersReceive', (header: Object) => {
        if (!header) {
          return;
        }
        const headers = header as Record<string, string>;
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase();
          if (lower === 'content-length') {
            const length = parseInt(headers[key], 10);
            if (!Number.isNaN(length)) {
              contentLength = length;
            }
          } else if (lower === 'etag') {
            etagHeader = headers[key];
          } else if (lower === 'last-modified') {
            lastModifiedHeader = headers[key];
          } else if (lower === 'content-range') {
            contentRangeHeader = headers[key];
          } else if (lower === 'content-encoding') {
            contentEncodingHeader = headers[key];
          }
        }
        const signalHeaders = headersResolve as (() => void) | null;
        if (signalHeaders) {
          signalHeaders();
        }
      });

      httpRequest.on('dataReceive', (data: ArrayBuffer) => {
        refreshWatchdog();
        if (writeError || discardBody) {
          return;
        }
        if (pendingChunks) {
          pendingChunks.push(data);
          return;
        }
        enqueueWrite(data);
        reportProgress();
      });

      httpRequest.on(
        'dataReceiveProgress',
        (data: http.DataReceiveProgressInfo) => {
          // Only refine the known total here; progress events are emitted from
          // the dataReceive handler to avoid double-firing.
          if (data.totalSize > 0) {
            contentLength = data.totalSize;
          }
        },
      );

      const requestHeader: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
      };
      if (resumeOffset > 0) {
        // 只有续传请求钉死编码:Range 偏移必须与盘上字节一一对应。
        // 全新下载保留平台默认的压缩处理,与引入续传前的行为一致。
        requestHeader['Accept-Encoding'] = 'identity';
        requestHeader.Range = `bytes=${resumeOffset}-`;
        const validator = resumeMeta?.etag || resumeMeta?.lastModified;
        if (validator) {
          // 带验证器时文件已变更的服务端会退回完整 200,而不是把不匹配
          // 的字节接上来。
          requestHeader['If-Range'] = validator;
        }
      }

      const remainingMs = Math.max(1, deadlineUptimeMs - monotonicNowMs());
      const deadlinePromise = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(
            createUpdateError(
              ERROR_DOWNLOAD_FAILED,
              'Download exceeded its whole-call deadline',
            ),
          );
        }, remainingMs);
      });
      // netstack 把 readTimeout 交给 libcurl 的 CURLOPT_TIMEOUT_MS(整次传输
      // 总时长)而非空闲超时:固定 60s 会让慢网上的大全量包次次失败。两个
      // 超时都取剩余 deadline;卡死由下面的 60s 不活动看门狗负责——两种
      // 语义下都正确。
      const responseCode = await Promise.race([
        httpRequest.requestInStream(params.url, {
          method: http.RequestMethod.GET,
          readTimeout: remainingMs,
          connectTimeout: remainingMs,
          header: requestHeader,
        }),
        deadlinePromise,
      ]);

      if (responseCode === 416) {
        discardBody = true;
        pendingChunks = null;
        const knownTotal = resumeMeta?.total ?? 0;
        if (knownTotal > 0 && fileIo.accessSync(params.targetFile)) {
          const stat = await fileIo.stat(params.targetFile);
          if (stat.size === knownTotal) {
            // partial 实际上就是完整文件。
            this.onProgressUpdate(knownTotal, knownTotal);
            return 'done';
          }
        }
        return 'staleRange';
      }
      if (responseCode > 299) {
        // 响应体从未落盘,partial + sidecar 原样保留——那就是续传状态。
        discardBody = true;
        pendingChunks = null;
        throw createUpdateError(
          ERROR_DOWNLOAD_FAILED,
          `Server error: ${responseCode}`,
        );
      }

      let encodedBody = false;
      if (resumeOffset > 0 && responseCode === 206) {
        // Content-Range 只能从 headersReceive 拿到,而它与 promise 的先后
        // 顺序不保证——等头到达(dataEnd 前必到,兜底 5s)再判定。
        let headersTimer = 0;
        await Promise.race([
          headersPromise,
          new Promise<void>(resolve => {
            headersTimer = setTimeout(resolve, 5000);
          }),
        ]);
        clearTimeout(headersTimer);
        encodedBody =
          !!contentEncodingHeader &&
          contentEncodingHeader.toLowerCase() !== 'identity';
        const parsedTotal = encodedBody
          ? -1
          : parseContentRangeTotal(contentRangeHeader, resumeOffset);
        if (parsedTotal < 0) {
          // 编码过的 range 字节、或 Content-Range 缺失/畸形/起点不符:
          // 追加不可信。按“partial 已过期”处理(删掉、干净地重来一次),
          // 而不是抛错——抛错会保留 partial,之后每次都撞同一堵墙。
          discardBody = true;
          pendingChunks = null;
          return 'staleRange';
        }
        baseOffset = resumeOffset;
        totalAll = parsedTotal;
        writer = await fileIo.open(
          params.targetFile,
          fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.APPEND,
        );
      } else {
        // 服务端忽略了 Range(或本就没发):从零开始。
        if (fileIo.accessSync(params.targetFile)) {
          await fileIo.unlink(params.targetFile);
        }
        baseOffset = 0;
        totalAll = contentLength > 0 ? contentLength : 0;
        writer = await fileIo.open(
          params.targetFile,
          fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
        );
      }
      if (totalAll > MAX_ARCHIVE_BYTES) {
        writeError = createUpdateError(
          ERROR_PATCH_FAILED,
          `archive too large: ${totalAll} bytes`,
        );
        throw writeError;
      }
      await ensureFreeSpace(
        params.targetFile,
        totalAll > 0 ? totalAll - baseOffset : 0,
      );
      // 先落 sidecar 再放行写入,流中崩溃才有得续。
      const meta: ResumeMeta = { url: params.url };
      const etag = etagHeader || resumeMeta?.etag;
      const lastModified = lastModifiedHeader || resumeMeta?.lastModified;
      if (etag) {
        meta.etag = etag;
      }
      if (lastModified) {
        meta.lastModified = lastModified;
      }
      if (totalAll > 0) {
        meta.total = totalAll;
      }
      await this.writeResumeMeta(params.targetFile, meta);

      // 鉴权通过:回放缓冲,之后的数据直写。
      const buffered = pendingChunks ?? [];
      pendingChunks = null;
      for (const chunk of buffered) {
        enqueueWrite(chunk);
      }
      if (buffered.length > 0) {
        reportProgress();
      }
      const grant = authorize as (() => void) | null;
      if (grant) {
        grant();
      }

      // watchdog 到这里才首次启动：requestInStream 阶段已有 connect/readTimeout
      // 覆盖；若提早启动，连接超过 60s 时 inactivityPromise 会在 race 尚无订阅者
      // 时 reject（unhandled rejection），且 promise 一经 reject 无法复活——
      // 即使随后数据正常流入，race 也必然以 "Download stalled" 失败。
      refreshWatchdog();
      await Promise.race([dataEndPromise, inactivityPromise, deadlinePromise]);
      // dataEnd 之后响应头必然已到齐,此时才能可靠判定编码。
      const finalEncoded =
        !!contentEncodingHeader &&
        contentEncodingHeader.toLowerCase() !== 'identity';
      const stats = await fileIo.stat(params.targetFile);
      if (!finalEncoded) {
        if (contentLength > 0 && received !== contentLength) {
          throw createUpdateError(
            ERROR_DOWNLOAD_FAILED,
            `Download incomplete: expected ${contentLength} bytes but got ${received} bytes`,
          );
        }
        if (totalAll > 0 && stats.size !== totalAll) {
          throw createUpdateError(
            ERROR_DOWNLOAD_FAILED,
            `Download incomplete: expected ${totalAll} total bytes but got ${stats.size} bytes`,
          );
        }
        // 用最终观测值刷新 sidecar:首次写入可能因头部竞态缺 total/验证器,
        // 补齐后“下载完、解压前死”的窗口才能被 complete 检测覆盖。
        const finalMeta: ResumeMeta = { url: params.url, total: stats.size };
        if (etagHeader || resumeMeta?.etag) {
          finalMeta.etag = etagHeader || resumeMeta?.etag;
        }
        if (lastModifiedHeader || resumeMeta?.lastModified) {
          finalMeta.lastModified =
            lastModifiedHeader || resumeMeta?.lastModified;
        }
        await this.writeResumeMeta(params.targetFile, finalMeta);
      } else {
        // 编码传输不可续传:盘上是解码后的字节,编码域的长度与偏移都失效。
        await this.deleteResumeSidecar(params.targetFile);
      }
      return 'done';
    } catch (error) {
      logger.error(TAG, `Download failed: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_DOWNLOAD_FAILED);
    } finally {
      clearWatchdog();
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
      }
      // 解除 dataEnd 对鉴权的等待(失败路径上可能从未放行)。
      const release = authorize as (() => void) | null;
      if (release) {
        release();
      }
      try {
        await closeWriter();
      } catch (closeError) {
        logger.error(TAG, `Failed to close file: ${getErrorMessage(closeError)}`);
      }
      httpRequest.off('headersReceive');
      httpRequest.off('dataReceive');
      httpRequest.off('dataReceiveProgress');
      httpRequest.off('dataEnd');
      httpRequest.destroy();
    }
  }

  private onProgressUpdate(received: number, total: number): void {
    this.eventHub.emit('RCTPushyDownloadProgress', {
      received,
      total,
      hash: this.hash,
    });
  }

  /**
   * 三种安装共用的脚手架:下载 → 重建 staging → 归档摘要(工作线程)→ 解压
   * (含上限校验)。返回 staging 目录。下载完成后的失败一律是 patch 应用
   * 失败(见 execute 的归码)。
   */
  private async downloadAndExtract(params: DownloadTaskParams): Promise<string> {
    await this.downloadFile(params);
    const work = this.stagingDirectory(params);
    await this.recreateDirectory(work);
    this.artifactSha256 = await NativePatchCore.sha256HexFileAsync(
      params.targetFile,
    );
    await this.extractArchive(params.targetFile, work);
    return work;
  }

  /** 解压目录里的条目名 + __diff.json 解析结果,供 patch plan 使用。 */
  private async readPatchInputs(
    work: string,
    normalizeResourceCopies: boolean,
  ): Promise<PatchInputs> {
    const results = await Promise.all([
      this.listEntryNames(work),
      this.readManifestArrays(work, normalizeResourceCopies),
    ]);
    return { entryNames: results[0], manifestArrays: results[1] };
  }

  private async doFullPatch(params: DownloadTaskParams): Promise<void> {
    await this.downloadAndExtract(params);
    await this.deleteArchiveAndSidecar(params.targetFile);
  }

  private async doPatchFromApp(params: DownloadTaskParams): Promise<void> {
    const work = await this.downloadAndExtract(params);
    const inputs = await this.readPatchInputs(work, true);
    const manifestArrays = inputs.manifestArrays;

    NativePatchCore.buildArchivePatchPlan(
      ARCHIVE_PATCH_TYPE_FROM_PACKAGE,
      inputs.entryNames,
      manifestArrays.copyFroms,
      manifestArrays.copyTos,
      manifestArrays.deletes,
      HARMONY_BUNDLE_PATCH_ENTRY,
    );

    const bundlePatchPath = `${work}/${HARMONY_BUNDLE_PATCH_ENTRY}`;
    if (!fileIo.accessSync(bundlePatchPath)) {
      throw createUpdateError(ERROR_PATCH_FAILED, 'bundle patch not found');
    }
    const resourceManager = this.context.resourceManager;
    const originContent = await resourceManager.getRawFileContent(
      'bundle.harmony.js',
    );
    await this.applyBundlePatchFromFileSource(
      originContent.buffer as ArrayBuffer,
      work,
      bundlePatchPath,
      `${work}/${HARMONY_BUNDLE_FILE_NAME}`,
      manifestArrays.hbcTransformMeta,
    );
    // 组按 from 聚合;同一 from 的内容必然一致,所以每组一个 CRC 即可
    // (与 manifest 逐位对齐的 copyCrcs 里取第一个非空值)。
    const crcByFrom = new Map<string, number>();
    manifestArrays.copyFroms.forEach((from, index) => {
      const crc = manifestArrays.copyCrcs[index];
      if (crc !== null && !crcByFrom.has(from)) {
        crcByFrom.set(from, crc);
      }
    });
    await this.copyFromResource(
      NativePatchCore.buildCopyGroups(
        manifestArrays.copyFroms,
        manifestArrays.copyTos,
      ),
      work,
      crcByFrom,
    );
    await this.deleteArchiveAndSidecar(params.targetFile);
  }

  private async doPatchFromPpk(params: DownloadTaskParams): Promise<void> {
    const work = await this.downloadAndExtract(params);
    const inputs = await this.readPatchInputs(work, false);
    const manifestArrays = inputs.manifestArrays;

    const plan = NativePatchCore.buildArchivePatchPlan(
      ARCHIVE_PATCH_TYPE_FROM_PPK,
      inputs.entryNames,
      manifestArrays.copyFroms,
      manifestArrays.copyTos,
      manifestArrays.deletes,
      HARMONY_BUNDLE_PATCH_ENTRY,
    );
    await NativePatchCore.applyPatchFromFileSource({
      copyFroms: manifestArrays.copyFroms,
      copyTos: manifestArrays.copyTos,
      deletes: manifestArrays.deletes,
      sourceRoot: params.originDirectory,
      targetRoot: work,
      originBundlePath: `${params.originDirectory}/bundle.harmony.js`,
      bundlePatchPath: `${work}/${HARMONY_BUNDLE_PATCH_ENTRY}`,
      bundleOutputPath: `${work}/${HARMONY_BUNDLE_FILE_NAME}`,
      mergeSourceSubdir: plan.mergeSourceSubdir,
      enableMerge: plan.enableMerge,
      bundleHbcTransformMeta: manifestArrays.hbcTransformMeta,
    });
    logger.info(TAG, 'Patch from PPK completed');
    await this.deleteArchiveAndSidecar(params.targetFile);
  }

  private async copyFromResource(
    copyGroups: CopyGroupResult[],
    targetRoot: string,
    crcByFrom?: Map<string, number>,
  ): Promise<void> {
    let currentFrom = '';
    try {
      const resourceManager = this.context.resourceManager;

      for (const group of copyGroups) {
        currentFrom = group.from;
        const targets = group.toPaths.map(path => `${targetRoot}/${path}`);
        if (targets.length === 0) {
          continue;
        }
        const expectedCrc = crcByFrom?.get(currentFrom);

        if (currentFrom.startsWith('resources/base/media/')) {
          // Strip only the final extension: 'icon.round.png' -> 'icon.round',
          // not 'icon' (getMediaByName expects the full resource name).
          const mediaName = currentFrom
            .replace('resources/base/media/', '')
            .replace(/\.[^.]+$/, '');
          const mediaBuffer = await resourceManager.getMediaByName(mediaName);
          this.verifyCopySourceCrc(mediaBuffer, expectedCrc, currentFrom);
          await this.ensureParentDirectories(targets);
          await Promise.all(
            targets.map(target => this.writeFileContent(target, mediaBuffer)),
          );
          continue;
        }

        if (expectedCrc !== undefined) {
          // 声明了 CRC 的条目改走字节路径:读出内容先校验再落盘。
          // 重打包的二进制里同名 rawfile 内容可能已漂移,fd 直拷会把
          // 错误字节静默装进版本目录。
          const rawContent =
            await resourceManager.getRawFileContent(currentFrom);
          this.verifyCopySourceCrc(rawContent, expectedCrc, currentFrom);
          const firstTarget = targets[0];
          const restTargets = targets.slice(1);
          await this.writeFileContent(firstTarget, rawContent);
          await Promise.all(
            restTargets.map(target => this.copySandboxFile(firstTarget, target)),
          );
          continue;
        }

        const fromContent = await resourceManager.getRawFd(currentFrom);
        try {
          const firstTarget = targets[0];
          const restTargets = targets.slice(1);
          await this.ensureParentDirectories(targets);
          if (fileIo.accessSync(firstTarget)) {
            await fileIo.unlink(firstTarget);
          }
          saveFileToSandbox(fromContent, firstTarget);
          await Promise.all(
            restTargets.map(target => this.copySandboxFile(firstTarget, target)),
          );
        } finally {
          try {
            await resourceManager.closeRawFd(currentFrom);
          } catch (closeError) {
            logger.error(
              TAG,
              `Failed to close raw fd for ${currentFrom}: ${getErrorMessage(closeError)}`,
            );
          }
        }
      }
    } catch (error) {
      const coded = toUpdateError(error, ERROR_PATCH_FAILED);
      const message = `Copy from resource failed: ${currentFrom}, ${getErrorMessage(error)}`;
      logger.error(TAG, message);
      throw createUpdateError(coded.code, message);
    }
  }

  /** 去重后并行创建所有目标文件的父目录。 */
  private async ensureParentDirectories(targets: string[]): Promise<void> {
    const parentDirs = new Set<string>();
    for (const target of targets) {
      const parent = target.substring(0, target.lastIndexOf('/'));
      if (parent) {
        parentDirs.add(parent);
      }
    }
    await Promise.all(
      Array.from(parentDirs).map(dir => this.ensureDirectory(dir)),
    );
  }

  // pdiff 拷贝源内容校验(__diff.json copiesCrc):不符即抛错,整次 patch
  // 失败后 JS 策略链自动回退 full,绝不把漂移的资源装进版本目录。
  private verifyCopySourceCrc(
    content: Uint8Array,
    expectedCrc: number | undefined,
    from: string,
  ): void {
    if (expectedCrc === undefined) {
      return;
    }
    const actualCrc = NativePatchCore.crc32(content);
    if (actualCrc !== expectedCrc) {
      throw createUpdateError(
        ERROR_PATCH_FAILED,
        `resource content mismatch (crc32): ${from}`,
      );
    }
  }

  private async doCleanUp(params: DownloadTaskParams): Promise<void> {
    try {
      await NativePatchCore.cleanupOldEntries(
        params.unzipDirectory,
        [params.hash, params.originHash].filter(name => !!name),
        3,
      );
    } catch (error) {
      const message = `Cleanup failed: ${getErrorMessage(error)}`;
      logger.error(TAG, message);
      throw createUpdateError(ERROR_FILE_OPERATION_FAILED, message);
    }
  }

  public async execute(params: DownloadTaskParams): Promise<void> {
    const isPatchTask =
      params.type === DownloadTaskParams.TASK_TYPE_PATCH_FULL ||
      params.type === DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP ||
      params.type === DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
    try {
      switch (params.type) {
        case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
          await this.doFullPatch(params);
          break;
        case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP:
          await this.doPatchFromApp(params);
          break;
        case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
          await this.doPatchFromPpk(params);
          break;
        case DownloadTaskParams.TASK_TYPE_CLEANUP:
          await this.doCleanUp(params);
          break;
        case DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD:
          await this.downloadFile(params);
          // 文件在完成时即是最终产物——残留的 sidecar 会让下次同 URL 的
          // 下载不发请求直接返回这份旧字节。
          await this.deleteResumeSidecar(params.targetFile);
          break;
        default:
          throw createUpdateError(
            ERROR_INVALID_OPTIONS,
            `Unknown task type: ${params.type}`,
          );
      }
      if (isPatchTask) {
        await this.promoteStaging(params);
      }
    } catch (rawError) {
      // 稳定错误码:下载阶段的失败是 DOWNLOAD_FAILED;归档收齐之后的失败
      // (解压/hpatch/资源拷贝含 copiesCrc 校验/完成记录)一律 PATCH_FAILED,
      // JS 层 patch-health 遥测据此区分网络失败与补丁失败。已带码的错误
      // (磁盘空间、参数)原样保留。
      const error = toUpdateError(
        rawError,
        this.downloadPhaseCompleted ? ERROR_PATCH_FAILED : ERROR_DOWNLOAD_FAILED,
      );
      logger.error(TAG, `Task execution failed: ${error.message}`);
      if (params.type !== DownloadTaskParams.TASK_TYPE_CLEANUP) {
        try {
          if (params.type === DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD) {
            await fileIo.unlink(params.targetFile);
            await this.deleteResumeSidecar(params.targetFile);
          } else {
            // Only the staging directory is ours to drop: the final version
            // directory is never touched by a failed install, so a failed
            // duplicate task cannot remove an earlier task's install.
            await this.removeDirectory(this.stagingDirectory(params));
            if (this.downloadPhaseCompleted) {
              // 收齐后才失败的是解压/patch 失败:归档有毒,续传只会撞上
              // 同一个失败。下载阶段的失败则保留 partial + sidecar——那
              // 就是续传状态。
              await this.deleteArchiveAndSidecar(params.targetFile);
            }
          }
        } catch (cleanupError) {
          logger.error(
            TAG,
            `Cleanup after error failed: ${getErrorMessage(cleanupError)}`,
          );
        }
      }
      throw error;
    }
  }
}
