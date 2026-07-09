import type { UpdateErrorCode } from './error';
import type { EventType } from './type';

// Server-side lifecycle event intake (POST {endpoint}/report/{appKey}); the
// enum must stay in sync with the server's client_event_type. Only these five
// aggregate types exist server-side — everything else stays local-only.
export type ServerEventType =
  | 'download_success'
  | 'download_fail'
  | 'patch_fail'
  | 'rollback'
  | 'mark_success';

// Failure detail is stored server-side in a VARCHAR(512); stay under it.
export const MAX_DETAIL_LENGTH = 500;

export interface ServerReportPayload {
  type: ServerEventType;
  hash: string;
  packageVersion?: string;
  cInfo?: {
    rnu?: string;
    rn?: string;
    os?: string;
    uuid?: string;
  };
  detail?: string;
}

/**
 * Maps a local report event to the server-side aggregate type, or undefined
 * for events the server does not collect. A DOWNLOAD_FAILED whose underlying
 * native code was PATCH_FAILED counts as patch_fail (the download itself
 * worked; applying it did not), same for switch-version failures.
 */
export const resolveServerEventType = (
  type: EventType,
  code?: UpdateErrorCode,
): ServerEventType | undefined => {
  switch (type) {
    case 'downloadSuccess':
      return 'download_success';
    case 'errorUpdate':
      return code === 'PATCH_FAILED' ? 'patch_fail' : 'download_fail';
    case 'errorSwitchVersion':
      // Activation failures are patch-health signals, but a throw from a
      // user hook (beforeReload) or a restart-mechanics failure is not —
      // those must not poison the stats driving the rollback safety net.
      return code === 'USER_HOOK_ERROR' || code === 'RESTART_FAILED'
        ? undefined
        : 'patch_fail';
    case 'markSuccess':
      return 'mark_success';
    case 'rollback':
      return 'rollback';
    default:
      return undefined;
  }
};

/**
 * The version hash a server event is about. Server-side rows key on it, so an
 * event without one is not reportable (returns '').
 */
export const resolveServerEventHash = ({
  serverType,
  data,
  currentVersion,
}: {
  serverType: ServerEventType;
  data: Record<string, string | number>;
  currentVersion: string;
}): string => {
  if (serverType === 'rollback') {
    return String(data.rolledBackVersion || '');
  }
  if (serverType === 'mark_success') {
    return String(data.newVersion || currentVersion || '');
  }
  return String(data.newVersion || '');
};

export const truncateDetail = (detail?: string) => {
  if (!detail) {
    return undefined;
  }
  return detail.slice(0, MAX_DETAIL_LENGTH);
};
