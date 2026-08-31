export type ErrorContextValue = string | number | boolean | null;

export interface ErrorReportContext {
  fatal?: boolean;
  componentStack?: string;
  extra?: Record<string, ErrorContextValue>;
}

export interface ErrorReportingOptions {
  /** Install a chained React Native ErrorUtils handler. Default: true. */
  captureGlobal?: boolean;
}

export interface SerializedException {
  name: string;
  message: string;
  stack: string;
  fatal: boolean;
  componentStack?: string;
  extra?: Record<string, ErrorContextValue>;
}

const MAX_NAME = 128;
const MAX_MESSAGE = 2 * 1024;
const MAX_STACK = 32 * 1024;
const MAX_COMPONENT_STACK = 16 * 1024;
const MAX_EXTRA_FIELDS = 32;
const MAX_EXTRA_KEY = 64;
const MAX_EXTRA_STRING = 1024;
const MAX_EXTRA_JSON = 8 * 1024;

const boundedString = (value: unknown, maximum: number) =>
  typeof value === 'string' ? value.slice(0, maximum) : '';

const normalizeExtra = (
  extra?: Record<string, ErrorContextValue>
): Record<string, ErrorContextValue> | undefined => {
  if (!extra || typeof extra !== 'object') {
    return undefined;
  }
  const result: Record<string, ErrorContextValue> = {};
  for (const [rawKey, value] of Object.entries(extra).slice(
    0,
    MAX_EXTRA_FIELDS
  )) {
    const key = rawKey.slice(0, MAX_EXTRA_KEY);
    if (!key) {
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value.slice(0, MAX_EXTRA_STRING);
    } else if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      result[key] = value;
    }
    // Keep the client comfortably inside the server's byte cap. The server
    // remains authoritative because JS string length is not UTF-8 byte length.
    if (JSON.stringify(result).length > MAX_EXTRA_JSON) {
      delete result[key];
      break;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

export const serializeException = (
  error: unknown,
  context: ErrorReportContext = {}
): SerializedException => {
  const source =
    error !== null && (typeof error === 'object' || typeof error === 'function')
      ? (error as Record<string, unknown>)
      : undefined;
  const name = boundedString(source?.name, MAX_NAME).trim() || 'Error';
  const message = (
    boundedString(source?.message, MAX_MESSAGE) || String(error ?? '')
  ).slice(0, MAX_MESSAGE);
  const stack =
    boundedString(source?.stack, MAX_STACK) || `${name}: ${message}`;
  const componentStack = boundedString(
    context.componentStack,
    MAX_COMPONENT_STACK
  );
  const extra = normalizeExtra(context.extra);
  return {
    name,
    message,
    stack,
    fatal: context.fatal === true,
    ...(componentStack ? { componentStack } : {}),
    ...(extra ? { extra } : {}),
  };
};

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface GlobalErrorUtils {
  getGlobalHandler?: () => GlobalErrorHandler;
  setGlobalHandler?: (handler: GlobalErrorHandler) => void;
}

/**
 * Install a React Native global error wrapper without taking ownership away
 * from ExceptionsManager, Sentry, Crashlytics, or a handler installed later.
 */
export const installGlobalErrorHandler = (
  capture: GlobalErrorHandler
): (() => void) => {
  const errorUtils = (globalThis as any).ErrorUtils as
    | GlobalErrorUtils
    | undefined;
  if (
    typeof errorUtils?.getGlobalHandler !== 'function' ||
    typeof errorUtils.setGlobalHandler !== 'function'
  ) {
    return () => {};
  }
  const previous = errorUtils.getGlobalHandler();
  const wrapper: GlobalErrorHandler = (error, isFatal) => {
    try {
      capture(error, isFatal);
    } catch {
      // Reporting must never alter React Native's original failure path.
    }
    previous?.(error, isFatal);
  };
  errorUtils.setGlobalHandler(wrapper);
  return () => {
    if (errorUtils.getGlobalHandler?.() === wrapper) {
      errorUtils.setGlobalHandler?.(previous);
    }
  };
};
