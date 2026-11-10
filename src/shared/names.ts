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

/**
 * Shell variable names, for "Put in a variable": letters, digits and "_",
 * not starting with a digit. Names the shell itself uses (PATH, IFS, the
 * prompts, BASH_*, HIST*) are refused, so a secret can never replace them.
 */
export const MAX_VARIABLE_LENGTH = 64;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SHELL_VARIABLES = new Set([
  "HOME",
  "IFS",
  "LANG",
  "LOGNAME",
  "OLDPWD",
  "OPTARG",
  "OPTIND",
  "PATH",
  "PROMPT_COMMAND",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PWD",
  "REPLY",
  "SHELL",
  "TERM",
  "USER",
]);

/** Whether the shell needs `name` for itself. */
export function isShellVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    SHELL_VARIABLES.has(upper) ||
    /^(BASH|HIST|ZSH|LC_)/.test(upper) ||
    name === "_"
  );
}

/** Whether `name` is a variable name "Put in a variable" may use. */
export function isValidVariableName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length <= MAX_VARIABLE_LENGTH &&
    VARIABLE.test(name) &&
    !isShellVariable(name)
  );
}

/**
 * The variable name offered for a secret: its name upper-cased, every
 * other character "_" (runbook-test gives RUNBOOK_TEST, db/prod/root gives
 * DB_PROD_ROOT), with "_" first when it would start with a digit.
 */
export function variableNameFor(secretName: string): string {
  let name = secretName.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (/^[0-9]/.test(name)) name = `_${name}`;
  name = name.slice(0, MAX_VARIABLE_LENGTH);
  if (name === "" || /^_+$/.test(name)) return "SECRET";
  return isShellVariable(name)
    ? `SECRET_${name}`.slice(0, MAX_VARIABLE_LENGTH)
    : name;
}

/**
 * The longest value `read` takes: a terminal line holds 4095 bytes before
 * the kernel cuts it (Linux's canonical mode).
 */
export const MAX_VARIABLE_VALUE_BYTES = 4000;

/**
 * Why a value cannot go through `IFS= read -rs`, or null when it can. The
 * value is typed as one line: an Enter in it would end `read` early and
 * run the rest as commands, and control characters act on the line.
 */
export function variableValueProblem(
  value: string,
): "multiline" | "control" | "long" | null {
  if (/[\r\n]/.test(value)) return "multiline";
  // Tab is plain text to read; every other control character is not.
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return "control";
  if (new TextEncoder().encode(value).length > MAX_VARIABLE_VALUE_BYTES) {
    return "long";
  }
  return null;
}
