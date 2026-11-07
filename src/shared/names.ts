/**
 * Secret names, shared by the backend (which enforces them) and the
 * frontend (which checks them before a request).
 *
 * A name is one to four segments joined by "/". A segment is letters,
 * digits, ".", "_" and "-", and is never "." or "..", so a name can never
 * climb out of its area in an OpenBao path.
 */

export const MAX_NAME_LENGTH = 200;
export const MAX_SEGMENTS = 4;
export const MAX_NOTE_LENGTH = 200;
/** One secret value: 64 KiB of text, far more than a password or a key. */
export const MAX_VALUE_LENGTH = 65_536;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function validSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

/** Whether `name` is a valid secret name. */
export function isValidName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  const segments = name.split("/");
  return segments.length <= MAX_SEGMENTS && segments.every(validSegment);
}

/**
 * A folder prefix, as list() and removePrefix() take it: "" for the whole
 * area, or a name, with or without a trailing "/". Returns the prefix
 * without the slash, or null when it is not valid.
 */
export function normalizePrefix(prefix: unknown): string | null {
  if (prefix === undefined || prefix === null || prefix === "") return "";
  if (typeof prefix !== "string") return null;
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return isValidName(trimmed) ? trimmed : null;
}

/** Whether `name` is `prefix` itself or sits under it. */
export function underPrefix(name: string, prefix: string): boolean {
  return prefix === "" || name === prefix || name.startsWith(`${prefix}/`);
}
