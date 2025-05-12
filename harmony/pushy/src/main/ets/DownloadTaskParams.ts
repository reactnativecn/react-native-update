export interface DownloadTaskListener {
  onDownloadCompleted(params: DownloadTaskParams): void;
  onDownloadFailed(error: Error): void;
}

/**
 * 下载任务参数类
 */
export class DownloadTaskParams {
  // 任务类型常量
  static readonly TASK_TYPE_CLEANUP: number = 0;        // 保留hash和originHash
  static readonly TASK_TYPE_PATCH_FULL: number = 1;     // 全量补丁
  static readonly TASK_TYPE_PATCH_FROM_APP: number = 2; // 从APP补丁
  static readonly TASK_TYPE_PATCH_FROM_PPK: number = 3; // 从PPK补丁
  static readonly TASK_TYPE_PLAIN_DOWNLOAD: number = 4; // 普通下载

  type: number;                 // 任务类型
  url: string;                  // 下载URL
  hash: string;                 // 文件哈希值
  originHash: string;           // 原始文件哈希值
  targetFile: string;           // 目标文件路径
  unzipDirectory: string;       // 解压目录路径
  originDirectory: string;      // 原始文件目录路径
  listener: DownloadTaskListener; // 下载监听器
}