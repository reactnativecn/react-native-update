import NativeUpdateCore from 'librnupdate.so';

export const STATE_OP_SWITCH_VERSION = 1;
export const STATE_OP_MARK_SUCCESS = 2;
export const STATE_OP_ROLLBACK = 3;
export const STATE_OP_CLEAR_FIRST_TIME = 4;
export const STATE_OP_CLEAR_ROLLBACK_MARK = 5;
export const STATE_OP_RESOLVE_LAUNCH = 6;

export const ARCHIVE_PATCH_TYPE_FULL = 1;
export const ARCHIVE_PATCH_TYPE_FROM_PACKAGE = 2;
export const ARCHIVE_PATCH_TYPE_FROM_PPK = 3;

export interface StateCoreResult {
  packageVersion?: string;
  buildTime?: string;
  currentVersion?: string;
  lastVersion?: string;
  firstTime: boolean;
  firstTimeOk: boolean;
  rolledBackVersion?: string;
  changed?: boolean;
  staleVersionToDelete?: string;
  loadVersion?: string;
  didRollback?: boolean;
  consumedFirstTime?: boolean;
}

export interface ArchivePatchPlanResult {
  mergeSourceSubdir?: string;
  enableMerge: boolean;
}

export interface CopyGroupResult {
  from: string;
  toPaths: string[];
}

export interface FileSourcePatchRequest {
  copyFroms: string[];
  copyTos: string[];
  deletes: string[];
  sourceRoot: string;
  targetRoot: string;
  originBundlePath: string;
  bundlePatchPath: string;
  bundleOutputPath: string;
  mergeSourceSubdir?: string;
  enableMerge?: boolean;
  /** __diff.json 中该 bundle patch 条目的 hbcTransform 元数据(原始 JSON) */
  bundleHbcTransformMeta?: string;
}

interface NativePatchCoreBindings {
  syncStateWithBinaryVersion(
    packageVersion: string,
    buildTime: string,
    state: StateCoreResult,
  ): StateCoreResult;
  runStateCore(
    operation: number,
    state: StateCoreResult,
    stringArg?: string,
    flagA?: boolean,
    flagB?: boolean,
  ): StateCoreResult;
  buildArchivePatchPlan(
    patchType: number,
    entryNames: string[],
    copyFroms: string[],
    copyTos: string[],
    deletes: string[],
    bundlePatchEntryName?: string,
  ): ArchivePatchPlanResult;
  buildCopyGroups(copyFroms: string[], copyTos: string[]): CopyGroupResult[];
  applyPatchFromFileSource(options: FileSourcePatchRequest): Promise<void>;
  /**
   * 删除 rootDir 下超过 maxAgeDays 且名字不在 keepNames 里的条目(native
   * 工作线程)。keepNames 必须包含所有可能仍在使用的版本:持久化的
   * current/last 以及本进程实际启动的版本。
   */
  cleanupOldEntries(
    rootDir: string,
    keepNames: string[],
    maxAgeDays: number,
  ): Promise<void>;
  /** sha256(小写 hex)。同步:输入是已在内存的 rawfile bundle,哈希毫秒级 */
  sha256Hex(data: Uint8Array): string;
  // 文件流式 SHA-256(小写 hex;不可读时空串)。同步,仅限小文件——整包/
  // 整 bundle 用下面的异步版本,避免冻结 UI 线程。
  sha256HexFile(path: string): string;
  // 同上,在 libuv 工作线程计算;文件不可读时 reject。
  sha256HexFileAsync(path: string): Promise<string>;
  /** CRC32(zip/zlib 多项式)。pdiff 拷贝前与 copiesCrc 比对用 */
  crc32(data: Uint8Array | ArrayBuffer): number;
  /** 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道) */
  getSupportedDiffVersion(): number;

  // 更新流程决策层(cpp/update_flow_core,NATIVE_CHECKUPDATE_DESIGN §10):
  // JSON 字符串进出,与决策层自身的边界一致。返回 undefined = 输入未通过
  // 解析,编排器跳过本轮检测。
  buildCheckRequestBody(inputJson: string): string | undefined;
  orderEndpointCandidates(
    endpointsJson: string,
    randomSample: number,
  ): string | undefined;
  handleCheckResponse(
    responseText: string,
    identityJson: string,
    afterDownload: string,
  ): string | undefined;
  // 响应 schema 门槛(update_flow_core::IsValidCheckResponse):200 但只带
  // `{"error":...}` 的节点算失败,不得阻止继续 fallback。
  isValidCheckResponse(responseText: string): boolean;
}

export default NativeUpdateCore as unknown as NativePatchCoreBindings;
