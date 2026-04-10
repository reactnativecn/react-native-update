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
}

interface NativePatchCoreBindings {
  hdiffPatch(
    origin: Uint8Array,
    patch: Uint8Array,
  ): ArrayBuffer | Uint8Array;
  sha256Hex(bytes: Uint8Array): string;
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
  applyPatchFromFileSource(options: FileSourcePatchRequest): void;
  cleanupOldEntries(
    rootDir: string,
    keepCurrent: string,
    keepPrevious: string,
    maxAgeDays: number,
  ): void;
}

export default NativeUpdateCore as unknown as NativePatchCoreBindings;
