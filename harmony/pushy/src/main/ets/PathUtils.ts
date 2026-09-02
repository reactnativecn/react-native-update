import { ERROR_INVALID_OPTIONS, createUpdateError } from './ErrorCodes';

// Server-controlled identifiers are used as children of the update root. Keep
// validation in a dependency-light module (ErrorCodes.ts has no imports) so
// startup orchestration and storage code can share it without creating an
// import cycle.
export function isSafePathComponent(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

export function assertSafePathComponent(name: string): string {
  if (!isSafePathComponent(name)) {
    throw createUpdateError(
      ERROR_INVALID_OPTIONS,
      `Invalid path component: ${name}`,
    );
  }
  return name;
}
