import http from '@ohos.net.http';
import fileIo from '@ohos.file.fs';
import common from '@ohos.app.ability.common';
import { zlib } from '@kit.BasicServicesKit';
import { EventHub } from './EventHub';
import { DownloadTaskParams } from './DownloadTaskParams';
import Pushy from 'librnupdate.so';

interface ZipEntry {
  filename: string;
  content: ArrayBuffer;
}

interface ZipFile {
  entries: ZipEntry[];
}

export class DownloadTask {
  private context: common.Context;
  private hash: string;
  private readonly DOWNLOAD_CHUNK_SIZE = 4096;
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

  private async downloadFile(params: DownloadTaskParams): Promise<void> {
    const httpRequest = http.createHttp();
    this.hash = params.hash;

    try {
      let exists = fileIo.accessSync(params.targetFile);
      if (exists) {
        await fileIo.unlink(params.targetFile);
      } else {
        const targetDir = params.targetFile.substring(
          0,
          params.targetFile.lastIndexOf('/'),
        );
        exists = fileIo.accessSync(targetDir);
        if (!exists) {
          await fileIo.mkdir(targetDir);
        }
      }

      const response = await httpRequest.request(params.url, {
        method: http.RequestMethod.GET,
        readTimeout: 60000,
        connectTimeout: 60000,
        header: {
          'Content-Type': 'application/octet-stream',
        },
      });
      if (response.responseCode > 299) {
        throw Error(`Server error: ${response.responseCode}`);
      }

      const contentLength = parseInt(response.header['content-length'] || '0');
      const writer = await fileIo.open(
        params.targetFile,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE,
      );
      let received = 0;
      const data = response.result as ArrayBuffer;
      const chunks = Math.ceil(data.byteLength / this.DOWNLOAD_CHUNK_SIZE);
      for (let i = 0; i < chunks; i++) {
        const start = i * this.DOWNLOAD_CHUNK_SIZE;
        const end = Math.min(start + this.DOWNLOAD_CHUNK_SIZE, data.byteLength);
        const chunk = data.slice(start, end);

        await fileIo.write(writer.fd, chunk);
        received += chunk.byteLength;

        this.onProgressUpdate(received, contentLength);
      }
      await fileIo.close(writer);
      const stats = await fileIo.stat(params.targetFile);
      const fileSize = stats.size;
      if (fileSize !== contentLength) {
        throw Error(
          `Download incomplete: expected ${contentLength} bytes but got ${stats.size} bytes`,
        );
      }
    } catch (error) {
      console.error('Download failed:', error);
      throw error;
    } finally {
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
    await this.removeDirectory(params.unzipDirectory);
    await fileIo.mkdir(params.unzipDirectory);

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
      console.error('Failed to process unzipped files:', error);
      throw error;
    }
  }

  private async doPatchFromApp(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.removeDirectory(params.unzipDirectory);
    await fileIo.mkdir(params.unzipDirectory);

    let foundDiff = false;
    let foundBundlePatch = false;
    const copyList: Map<string, Array<any>> = new Map();
    await zlib.decompressFile(params.targetFile, params.unzipDirectory);
    const zipFile = await this.processUnzippedFiles(params.unzipDirectory);
    for (const entry of zipFile.entries) {
      const fn = entry.filename;

      if (fn === '__diff.json') {
        foundDiff = true;
        let jsonContent = '';
        const bufferArray = new Uint8Array(entry.content);
        for (let i = 0; i < bufferArray.length; i++) {
          jsonContent += String.fromCharCode(bufferArray[i]);
        }
        const obj = JSON.parse(jsonContent);

        const copies = obj.copies as Record<string, string>;
        for (const [to, rawPath] of Object.entries(copies)) {
          if (!rawPath.startsWith('resources/rawfile/')) {
            // skip other resource
            continue;
          }
          let from = rawPath.replace('resources/rawfile/', '');
          if (from === '') {
            from = to;
          }

          if (!copyList.has(from)) {
            copyList.set(from, []);
          }

          const target = copyList.get(from);
          if (target) {
            const toFile = `${params.unzipDirectory}/${to}`;
            target.push(toFile);
          }
        }
        continue;
      }
      if (fn === 'bundle.harmony.js.patch') {
        foundBundlePatch = true;
        try {
          const resourceManager = this.context.resourceManager;
          const originContent = await resourceManager.getRawFileContent(
            'bundle.harmony.js',
          );
          const patched = await Pushy.hdiffPatch(
            new Uint8Array(originContent.buffer),
            new Uint8Array(entry.content),
          );
          const outputFile = `${params.unzipDirectory}/bundle.harmony.js`;
          const writer = await fileIo.open(
            outputFile,
            fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
          );
          const chunkSize = 4096;
          let bytesWritten = 0;
          const totalLength = patched.byteLength;

          while (bytesWritten < totalLength) {
            const chunk = patched.slice(bytesWritten, bytesWritten + chunkSize);
            await fileIo.write(writer.fd, chunk);
            bytesWritten += chunk.byteLength;
          }
          await fileIo.close(writer);
          continue;
        } catch (error) {
          console.error('Failed to process bundle patch:', error);
          throw error;
        }
      }
    }

    if (!foundDiff) {
      throw Error('diff.json not found');
    }
    if (!foundBundlePatch) {
      throw Error('bundle patch not found');
    }
    await this.copyFromResource(copyList);
  }

  private async doPatchFromPpk(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.removeDirectory(params.unzipDirectory);
    await fileIo.mkdir(params.unzipDirectory);

    let foundDiff = false;
    let foundBundlePatch = false;
    await zlib.decompressFile(params.targetFile, params.unzipDirectory);
    const zipFile = await this.processUnzippedFiles(params.unzipDirectory);
    for (const entry of zipFile.entries) {
      const fn = entry.filename;

      if (fn === '__diff.json') {
        foundDiff = true;

        await fileIo
          .copyDir(params.originDirectory + '/', params.unzipDirectory + '/')
          .catch(error => {
            console.error('copy error:', error);
          });

        let jsonContent = '';
        const bufferArray = new Uint8Array(entry.content);
        for (let i = 0; i < bufferArray.length; i++) {
          jsonContent += String.fromCharCode(bufferArray[i]);
        }
        const obj = JSON.parse(jsonContent);

        const { copies, deletes } = obj;
        for (const [to, from] of Object.entries(copies)) {
          await fileIo
            .copyFile(
              `${params.originDirectory}/${from}`,
              `${params.unzipDirectory}/${to}`,
            )
            .catch(error => {
              console.error('copy error:', error);
            });
        }
        for (const fileToDelete of Object.keys(deletes)) {
          await fileIo
            .unlink(`${params.unzipDirectory}/${fileToDelete}`)
            .catch(error => {
              console.error('delete error:', error);
            });
        }
        continue;
      }
      if (fn === 'bundle.harmony.js.patch') {
        foundBundlePatch = true;
        const filePath = params.originDirectory + '/bundle.harmony.js';
        const res = fileIo.accessSync(filePath);
        if (res) {
          const stat = await fileIo.stat(filePath);
          const reader = await fileIo.open(filePath, fileIo.OpenMode.READ_ONLY);
          const fileSize = stat.size;
          const originContent = new ArrayBuffer(fileSize);
          try {
            await fileIo.read(reader.fd, originContent);
            const patched = await Pushy.hdiffPatch(
              new Uint8Array(originContent),
              new Uint8Array(entry.content),
            );
            const outputFile = `${params.unzipDirectory}/bundle.harmony.js`;
            const writer = await fileIo.open(
              outputFile,
              fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
            );
            const chunkSize = 4096;
            let bytesWritten = 0;
            const totalLength = patched.byteLength;
            while (bytesWritten < totalLength) {
              const chunk = patched.slice(
                bytesWritten,
                bytesWritten + chunkSize,
              );
              await fileIo.write(writer.fd, chunk);
              bytesWritten += chunk.byteLength;
            }
            await fileIo.close(writer);
            continue;
          } finally {
            await fileIo.close(reader);
          }
        }
      }
    }

    if (!foundDiff) {
      throw Error('diff.json not found');
    }
    if (!foundBundlePatch) {
      throw Error('bundle patch not found');
    }
    console.info('Patch from PPK completed');
  }

  private async copyFromResource(
    copyList: Map<string, Array<string>>,
  ): Promise<void> {
    let currentFrom = '';
    try {
      const resourceManager = this.context.resourceManager;

      for (const [from, targets] of copyList.entries()) {
        currentFrom = from;
        const fromContent = await resourceManager.getRawFileContent(from);
        for (const target of targets) {
          const fileStream = fileIo.createStreamSync(target, 'w+');
          fileStream.writeSync(fromContent.buffer);
          fileStream.close();
        }
      }
    } catch (error) {
      console.error('Copy from resource failed:', currentFrom, error.message);
      throw error;
    }
  }

  private async doCleanUp(params: DownloadTaskParams): Promise<void> {
    const DAYS_TO_KEEP = 7;
    const now = Date.now();
    const maxAge = DAYS_TO_KEEP * 24 * 60 * 60 * 1000;

    try {
      const files = await fileIo.listFile(params.unzipDirectory);
      for (const file of files) {
        if (file.startsWith('.')) {
          continue;
        }

        const filePath = `${params.unzipDirectory}/${file}`;
        const stat = await fileIo.stat(filePath);

        if (
          now - stat.mtime > maxAge &&
          file !== params.hash &&
          file !== params.originHash
        ) {
          if (stat.isDirectory()) {
            await this.removeDirectory(filePath);
          } else {
            await fileIo.unlink(filePath);
          }
        }
      }
    } catch (error) {
      console.error('Cleanup failed:', error);
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
