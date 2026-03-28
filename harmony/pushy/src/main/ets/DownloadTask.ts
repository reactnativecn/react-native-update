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

interface PatchManifestArrays {
  copyFroms: string[];
  copyTos: string[];
  deletes: string[];
}

const DIFF_MANIFEST_ENTRY = '__diff.json';
const HARMONY_BUNDLE_PATCH_ENTRY = 'bundle.harmony.js.patch';
const TEMP_ORIGIN_BUNDLE_ENTRY = '.origin.bundle.harmony.js';
const FILE_COPY_BUFFER_SIZE = 64 * 1024;

export class DownloadTask {
  private context: common.Context;
  private hash: string;
  private eventHub: EventHub;

  constructor(context: common.Context) {
    this.context = context;
    this.eventHub = EventHub.getInstance();
  }

  private async removeDirectory(path: string): Promise<void> {
    try {
      const res = fileIo.accessSync(path);
      if (res) {
        const stat = await fileIo.stat(path);
        if (stat.isDirectory()) {
          const files = await fileIo.listFile(path);
          for (const file of files) {
            if (file === '.' || file === '..') {
              continue;
            }
            await this.removeDirectory(`${path}/${file}`);
          }
          await fileIo.rmdir(path);
        } else {
          await fileIo.unlink(path);
        }
      }
    } catch (error) {
      console.error('Failed to delete directory:', error);
      throw error;
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
        const chunk = payload.subarray(bytesWritten, bytesWritten + chunkSize);
        await fileIo.write(writer.fd, chunk);
        bytesWritten += chunk.byteLength;
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
        deletes: [],
      };
    }

    return this.manifestToArrays(
      this.parseJsonEntry(await this.readFileContent(manifestPath)),
      normalizeResourceCopies,
    );
  }

  private manifestToArrays(
    manifest: Record<string, any>,
    normalizeResourceCopies: boolean,
  ): PatchManifestArrays {
    const copyFroms: string[] = [];
    const copyTos: string[] = [];
    const deletesValue = manifest.deletes;
    const deletes = Array.isArray(deletesValue)
      ? deletesValue.map(item => String(item))
      : deletesValue && typeof deletesValue === 'object'
        ? Object.keys(deletesValue)
        : [];

    const copies = (manifest.copies || {}) as Record<string, string>;
    for (const [to, rawFrom] of Object.entries(copies)) {
      let from = String(rawFrom || '');
      if (normalizeResourceCopies) {
        from = from.replace('resources/rawfile/', '');
        if (!from) {
          from = to;
        }
      }
      copyFroms.push(from);
      copyTos.push(to);
    }

    return {
      copyFroms,
      copyTos,
      deletes,
    };
  }

  private async applyBundlePatchFromFileSource(
    originContent: ArrayBuffer,
    workingDirectory: string,
    bundlePatchPath: string,
    outputFile: string,
  ): Promise<void> {
    const originBundlePath = `${workingDirectory}/${TEMP_ORIGIN_BUNDLE_ENTRY}`;
    try {
      await this.writeFileContent(originBundlePath, originContent);
      NativePatchCore.applyPatchFromFileSource({
        copyFroms: [],
        copyTos: [],
        deletes: [],
        sourceRoot: workingDirectory,
        targetRoot: workingDirectory,
        originBundlePath,
        bundlePatchPath,
        bundleOutputPath: outputFile,
        enableMerge: false,
      });
    } catch (error) {
      error.message = `Failed to process bundle patch: ${error.message}`;
      throw error;
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

        await fileIo.write(writer.fd, new Uint8Array(buffer, 0, readLength));
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
    const httpRequest = http.createHttp();
    this.hash = params.hash;
    let writer: fileIo.File | null = null;
    let contentLength = 0;
    let received = 0;
    let writeError: Error | null = null;
    let writeQueue = Promise.resolve();

    const closeWriter = async () => {
      if (writer) {
        await fileIo.close(writer);
        writer = null;
      }
    };

    const dataEndPromise = new Promise<void>((resolve, reject) => {
      httpRequest.on('dataEnd', () => {
        writeQueue
          .then(async () => {
            if (writeError) {
              throw writeError;
            }
            await closeWriter();
            resolve();
          })
          .catch(async error => {
            await closeWriter();
            reject(error);
          });
      });
    });

    try {
      let exists = fileIo.accessSync(params.targetFile);
      if (exists) {
        await fileIo.unlink(params.targetFile);
      } else {
        await this.ensureParentDirectory(params.targetFile);
      }

      writer = await fileIo.open(
        params.targetFile,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE,
      );

      httpRequest.on('headersReceive', (header: Record<string, string>) => {
        if (!header) {
          return;
        }
        const lengthKey = Object.keys(header).find(
          key => key.toLowerCase() === 'content-length',
        );
        if (!lengthKey) {
          return;
        }
        const length = parseInt(header[lengthKey], 10);
        if (!Number.isNaN(length)) {
          contentLength = length;
        }
      });

      httpRequest.on('dataReceive', (data: ArrayBuffer) => {
        if (writeError) {
          return;
        }
        received += data.byteLength;
        writeQueue = writeQueue.then(async () => {
          if (!writer || writeError) {
            return;
          }
          try {
            await fileIo.write(writer.fd, data);
          } catch (error) {
            writeError = error as Error;
          }
        });
        this.onProgressUpdate(received, contentLength);
      });

      httpRequest.on(
        'dataReceiveProgress',
        (data: http.DataReceiveProgressInfo) => {
          if (data.totalSize > 0) {
            contentLength = data.totalSize;
          }
          if (data.receiveSize > received) {
            received = data.receiveSize;
          }
          this.onProgressUpdate(received, contentLength);
        },
      );

      const responseCode = await httpRequest.requestInStream(params.url, {
        method: http.RequestMethod.GET,
        readTimeout: 60000,
        connectTimeout: 60000,
        header: {
          'Content-Type': 'application/octet-stream',
        },
      });
      if (responseCode > 299) {
        throw Error(`Server error: ${responseCode}`);
      }

      await dataEndPromise;
      const stats = await fileIo.stat(params.targetFile);
      const fileSize = stats.size;
      if (contentLength > 0 && fileSize !== contentLength) {
        throw Error(
          `Download incomplete: expected ${contentLength} bytes but got ${stats.size} bytes`,
        );
      }
    } catch (error) {
      console.error('Download failed:', error);
      throw error;
    } finally {
      try {
        await closeWriter();
      } catch (closeError) {
        console.error('Failed to close file:', closeError);
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

  private async doFullPatch(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.recreateDirectory(params.unzipDirectory);
    await zlib.decompressFile(params.targetFile, params.unzipDirectory);
  }

  private async doPatchFromApp(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.recreateDirectory(params.unzipDirectory);

    await zlib.decompressFile(params.targetFile, params.unzipDirectory);
    const [entryNames, manifestArrays] = await Promise.all([
      this.listEntryNames(params.unzipDirectory),
      this.readManifestArrays(params.unzipDirectory, true),
    ]);

    NativePatchCore.buildArchivePatchPlan(
      ARCHIVE_PATCH_TYPE_FROM_PACKAGE,
      entryNames,
      manifestArrays.copyFroms,
      manifestArrays.copyTos,
      manifestArrays.deletes,
      HARMONY_BUNDLE_PATCH_ENTRY,
    );

    const bundlePatchPath = `${params.unzipDirectory}/${HARMONY_BUNDLE_PATCH_ENTRY}`;
    if (!fileIo.accessSync(bundlePatchPath)) {
      throw Error('bundle patch not found');
    }
    const resourceManager = this.context.resourceManager;
    const originContent = await resourceManager.getRawFileContent(
      'bundle.harmony.js',
    );
    await this.applyBundlePatchFromFileSource(
      originContent,
      params.unzipDirectory,
      bundlePatchPath,
      `${params.unzipDirectory}/bundle.harmony.js`,
    );
    await this.copyFromResource(
      NativePatchCore.buildCopyGroups(
        manifestArrays.copyFroms,
        manifestArrays.copyTos,
      ),
      params.unzipDirectory,
    );
  }

  private async doPatchFromPpk(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.recreateDirectory(params.unzipDirectory);

    await zlib.decompressFile(params.targetFile, params.unzipDirectory);
    const [entryNames, manifestArrays] = await Promise.all([
      this.listEntryNames(params.unzipDirectory),
      this.readManifestArrays(params.unzipDirectory, false),
    ]);

    const plan = NativePatchCore.buildArchivePatchPlan(
      ARCHIVE_PATCH_TYPE_FROM_PPK,
      entryNames,
      manifestArrays.copyFroms,
      manifestArrays.copyTos,
      manifestArrays.deletes,
      HARMONY_BUNDLE_PATCH_ENTRY,
    );
    NativePatchCore.applyPatchFromFileSource({
      copyFroms: manifestArrays.copyFroms,
      copyTos: manifestArrays.copyTos,
      deletes: manifestArrays.deletes,
      sourceRoot: params.originDirectory,
      targetRoot: params.unzipDirectory,
      originBundlePath: `${params.originDirectory}/bundle.harmony.js`,
      bundlePatchPath: `${params.unzipDirectory}/${HARMONY_BUNDLE_PATCH_ENTRY}`,
      bundleOutputPath: `${params.unzipDirectory}/bundle.harmony.js`,
      mergeSourceSubdir: plan.mergeSourceSubdir,
      enableMerge: plan.enableMerge,
    });
    console.info('Patch from PPK completed');
  }

  private async copyFromResource(
    copyGroups: CopyGroupResult[],
    targetRoot: string,
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

        if (currentFrom.startsWith('resources/base/media/')) {
          const mediaName = currentFrom
            .replace('resources/base/media/', '')
            .split('.')[0];
          const mediaBuffer = await resourceManager.getMediaByName(mediaName);
          const parentDirs = [
            ...new Set(
              targets.map(t => t.substring(0, t.lastIndexOf('/'))).filter(Boolean),
            ),
          ];
          for (const dir of parentDirs) {
            await this.ensureDirectory(dir);
          }
          await Promise.all(
            targets.map(target => this.writeFileContent(target, mediaBuffer.buffer)),
          );
          continue;
        }
        const fromContent = await resourceManager.getRawFd(currentFrom);
        const [firstTarget, ...restTargets] = targets;
        const parentDirs = [
          ...new Set(
            targets.map(t => t.substring(0, t.lastIndexOf('/'))).filter(Boolean),
          ),
        ];
        for (const dir of parentDirs) {
          await this.ensureDirectory(dir);
        }
        if (fileIo.accessSync(firstTarget)) {
          await fileIo.unlink(firstTarget);
        }
        saveFileToSandbox(fromContent, firstTarget);
        await Promise.all(
          restTargets.map(target => this.copySandboxFile(firstTarget, target)),
        );
      }
    } catch (error) {
      error.message =
        'Copy from resource failed:' +
        currentFrom +
        ',' +
        error.code +
        ',' +
        error.message;
      console.error(error);
      throw error;
    }
  }

  private async doCleanUp(params: DownloadTaskParams): Promise<void> {
    try {
      NativePatchCore.cleanupOldEntries(
        params.unzipDirectory,
        params.hash || '',
        params.originHash || '',
        7,
      );
    } catch (error) {
      error.message = 'Cleanup failed:' + error.message;
      console.error(error);
      throw error;
    }
  }

  public async execute(params: DownloadTaskParams): Promise<void> {
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
          break;
        default:
          throw Error(`Unknown task type: ${params.type}`);
      }
    } catch (error) {
      console.error('Task execution failed:', error.message);
      if (params.type !== DownloadTaskParams.TASK_TYPE_CLEANUP) {
        try {
          if (params.type === DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD) {
            await fileIo.unlink(params.targetFile);
          } else {
            await this.removeDirectory(params.unzipDirectory);
          }
        } catch (cleanupError) {
          console.error('Cleanup after error failed:', cleanupError.message);
        }
      }
      throw error;
    }
  }
}
