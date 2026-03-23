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

interface ZipEntry {
  filename: string;
  content: ArrayBuffer;
}

interface ZipFile {
  entries: ZipEntry[];
}

interface PatchManifestArrays {
  copyFroms: string[];
  copyTos: string[];
  deletes: string[];
}

const HARMONY_BUNDLE_PATCH_ENTRY = 'bundle.harmony.js.patch';

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
      await fileIo.mkdir(path);
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

  private toUint8Array(content: ArrayBuffer | Uint8Array): Uint8Array {
    if (content instanceof Uint8Array) {
      return content;
    }
    return new Uint8Array(content);
  }

  private async writeFileContent(
    targetFile: string,
    content: ArrayBuffer | Uint8Array,
  ): Promise<void> {
    const payload = this.toUint8Array(content);
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
      const chunkSize = 4096;
      let bytesWritten = 0;

      while (bytesWritten < payload.byteLength) {
        const chunk = payload.slice(bytesWritten, bytesWritten + chunkSize);
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

  private async applyBundlePatch(
    originContent: ArrayBuffer | Uint8Array,
    patchContent: ArrayBuffer | Uint8Array,
    outputFile: string,
  ): Promise<void> {
    try {
      const patched = await NativePatchCore.hdiffPatch(
        this.toUint8Array(originContent),
        this.toUint8Array(patchContent),
      );
      await this.writeFileContent(outputFile, patched);
    } catch (error) {
      error.message = `Failed to process bundle patch: ${error.message}`;
      throw error;
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

  private async processUnzippedFiles(directory: string): Promise<ZipFile> {
    const entries: ZipEntry[] = [];
    try {
      const files = await fileIo.listFile(directory);
      for (const file of files) {
        if (file === '.' || file === '..') {
          continue;
        }

        const filePath = `${directory}/${file}`;
        const stat = await fileIo.stat(filePath);

        if (!stat.isDirectory()) {
          const reader = await fileIo.open(filePath, fileIo.OpenMode.READ_ONLY);
          const fileSize = stat.size;
          const content = new ArrayBuffer(fileSize);

          try {
            await fileIo.read(reader.fd, content);
            entries.push({
              filename: file,
              content: content,
            });
          } finally {
            await fileIo.close(reader);
          }
        }
      }

      return { entries };
    } catch (error) {
      error.message = 'Failed to process unzipped files:' + error.message;
      console.error(error);
      throw error;
    }
  }

  private async doPatchFromApp(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.recreateDirectory(params.unzipDirectory);

    await zlib.decompressFile(params.targetFile, params.unzipDirectory);
    const zipFile = await this.processUnzippedFiles(params.unzipDirectory);
    const entryNames = zipFile.entries.map(entry => entry.filename);
    let bundlePatchContent: ArrayBuffer | null = null;
    let manifestArrays: PatchManifestArrays = {
      copyFroms: [],
      copyTos: [],
      deletes: [],
    };

    for (const entry of zipFile.entries) {
      const fn = entry.filename;

      if (fn === '__diff.json') {
        manifestArrays = this.manifestToArrays(
          this.parseJsonEntry(entry.content),
          true,
        );
        continue;
      }
      if (fn === HARMONY_BUNDLE_PATCH_ENTRY) {
        bundlePatchContent = entry.content;
      }
    }

    NativePatchCore.buildArchivePatchPlan(
      ARCHIVE_PATCH_TYPE_FROM_PACKAGE,
      entryNames,
      manifestArrays.copyFroms,
      manifestArrays.copyTos,
      manifestArrays.deletes,
      HARMONY_BUNDLE_PATCH_ENTRY,
    );
    if (!bundlePatchContent) {
      throw Error('bundle patch not found');
    }
    const resourceManager = this.context.resourceManager;
    const originContent = await resourceManager.getRawFileContent(
      'bundle.harmony.js',
    );
    await this.applyBundlePatch(
      originContent,
      bundlePatchContent,
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
    const zipFile = await this.processUnzippedFiles(params.unzipDirectory);
    const entryNames = zipFile.entries.map(entry => entry.filename);
    let manifestArrays: PatchManifestArrays = {
      copyFroms: [],
      copyTos: [],
      deletes: [],
    };

    for (const entry of zipFile.entries) {
      if (entry.filename === '__diff.json') {
        manifestArrays = this.manifestToArrays(
          this.parseJsonEntry(entry.content),
          false,
        );
      }
    }

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
        if (currentFrom.startsWith('resources/base/media/')) {
          const mediaName = currentFrom
            .replace('resources/base/media/', '')
            .split('.')[0];
          const mediaBuffer = await resourceManager.getMediaByName(mediaName);
          for (const target of targets) {
            await this.ensureParentDirectory(target);
            const fileStream = fileIo.createStreamSync(target, 'w+');
            fileStream.writeSync(mediaBuffer.buffer);
            fileStream.close();
          }
          continue;
        }
        const fromContent = await resourceManager.getRawFd(currentFrom);
        for (const target of targets) {
          await this.ensureParentDirectory(target);
          saveFileToSandbox(fromContent, target);
        }
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
