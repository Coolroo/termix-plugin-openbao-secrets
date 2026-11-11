/**
 * The connection settings an admin saves, read and checked on every use.
 *
 * Only https is accepted. The secret ID is never a setting: it comes from a
 * response-wrapped token through the Connect form (see connection.ts).
 */

import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

export interface Config {
  /** The address without a trailing slash, e.g. https://bao.example:8200. */
  address: string;
  /** The exact host ctx.fetch may reach even when it is private. */
  host: string;
  /** PEM bundle to trust instead of the default store, or null. */
  caPem: string | null;
  kvMount: string;
  basePath: string;
  roleId: string;
}

export const DEFAULT_KV_MOUNT = "kv";
export const DEFAULT_BASE_PATH = "termix";

const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ROLE_ID = /^[\x21-\x7e]{1,256}$/;

/** A mount or base path: one to four plain segments. */
export function isValidPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length <= 4 &&
    segments.every(
      (segment) =>
        PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..",
    )
  );
}

/** Why an address is refused, or null when it is fine. */
export function addressProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "Enter the OpenBao address, like https://bao.example.com:8200";
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "This is not a valid address";
  }
  if (url.protocol !== "https:") {
    return "The address must start with https://";
  }
  if (url.username || url.password) {
    return "The address must not contain a user name or password";
  }
  if (url.search || url.hash) {
    return "The address must not contain ? or #";
  }
  return null;
}

/** The host part of an https address, as ctx.fetch compares it. */
export function hostOf(address: string): string {
  return new URL(address).hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function caProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "The CA must be PEM text";
  if (!value.trim()) return null;
  if (!value.includes("-----BEGIN CERTIFICATE-----")) {
    return "Paste one or more PEM certificates (-----BEGIN CERTIFICATE-----)";
  }
  return null;
}

export function roleIdProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "Enter the AppRole role ID";
  }
  if (!ROLE_ID.test(value.trim())) {
    return "The role ID has characters it cannot have";
  }
  return null;
}

/** Field errors for a save of the admin settings, as onValidate returns them. */
export function validateSettings(
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if ("address" in values && values.address) {
    const problem = addressProblem(values.address);
    if (problem) errors.address = problem;
  }
  if ("caPem" in values) {
    const problem = caProblem(values.caPem);
    if (problem) errors.caPem = problem;
  }
  for (const key of ["kvMount", "basePath"] as const) {
    if (key in values && values[key] && !isValidPath(values[key])) {
      errors[key] =
        "Use one to four parts of letters, digits, '.', '_' and '-', joined by '/'";
    }
  }
  if ("roleId" in values && values.roleId) {
    const problem = roleIdProblem(values.roleId);
    if (problem) errors.roleId = problem;
  }
  if (
    "appsBasePath" in values &&
    typeof values.appsBasePath === "string" &&
    values.appsBasePath.trim()
  ) {
    const basePath =
      typeof values.basePath === "string" && values.basePath
        ? values.basePath
        : DEFAULT_BASE_PATH;
    const problem = appsBasePathProblem(values.appsBasePath.trim(), basePath);
    if (problem) errors.appsBasePath = problem;
  }
  if ("allowedAppPaths" in values) {
    const { problem } = parseAllowedAppPaths(values.allowedAppPaths);
    if (problem) errors.allowedAppPaths = problem;
  }
  return errors;
}

/**
 * Create-only app secrets (1.0.5): a KV folder for other apps' secrets and
 * the `<app>/<host>` entries under it a plugin may add new fields to. Both
 * are empty by default, and the feature is off until an admin sets both.
 */
export const MAX_ALLOWED_APP_PATHS = 200;
const APP_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

/** One `<app>` or `<host>` part: letters, digits, '.', '_', '-'. */
export function isAppSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    APP_SEGMENT.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

/**
 * The "Allowed app paths" setting: one `<app>/<host>` per line (commas
 * work too). Blank lines are skipped. Returns the entries, or a problem.
 */
export function parseAllowedAppPaths(value: unknown): {
  entries: string[];
  problem: string | null;
} {
  if (value === undefined || value === null) {
    return { entries: [], problem: null };
  }
  if (typeof value !== "string") {
    return { entries: [], problem: "Enter one <app>/<host> per line" };
  }
  const entries: string[] = [];
  for (const raw of value.split(/[\n,]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const parts = entry.split("/");
    if (parts.length !== 2 || !parts.every(isAppSegment)) {
      return {
        entries: [],
        problem: `"${entry.slice(0, 80)}" is not <app>/<host>: two parts of letters, digits, '.', '_' and '-'`,
      };
    }
    if (!entries.includes(entry)) entries.push(entry);
  }
  if (entries.length > MAX_ALLOWED_APP_PATHS) {
    return {
      entries: [],
      problem: `At most ${MAX_ALLOWED_APP_PATHS} app paths`,
    };
  }
  return { entries, problem: null };
}

/** Why an app secrets folder is refused next to the plugin's base path. */
export function appsBasePathProblem(
  appsBasePath: unknown,
  basePath: string,
): string | null {
  if (!isValidPath(appsBasePath)) {
    return "Use one to four parts of letters, digits, '.', '_' and '-', joined by '/'";
  }
  if (
    appsBasePath === basePath ||
    appsBasePath.startsWith(`${basePath}/`) ||
    basePath.startsWith(`${appsBasePath}/`)
  ) {
    return "The app secrets folder must be outside the base path, and the base path outside it";
  }
  return null;
}

export class ConfigError extends Error {
  readonly status = 409;
}

export interface AppsConfig {
  /** The KV folder (under the KV mount) that holds `<app>/<host>`. */
  basePath: string;
  allowed: ReadonlySet<string>;
}

/**
 * The create-only app secrets settings, or null when the feature is off
 * (either setting empty). A saved value that is not valid is a ConfigError,
 * never "allowed".
 */
export async function readAppsConfig(
  ctx: PluginContext,
): Promise<AppsConfig | null> {
  const saved = await ctx.settings.get<unknown>("appsBasePath");
  const appsBasePath = typeof saved === "string" ? saved.trim() || null : null;
  const parsed = parseAllowedAppPaths(
    await ctx.settings.get<string>("allowedAppPaths"),
  );
  if (!appsBasePath || (!parsed.problem && parsed.entries.length === 0)) {
    return null;
  }
  if (parsed.problem) {
    throw new ConfigError("The allowed app paths setting is not valid");
  }
  const basePath =
    (await ctx.settings.get<string>("basePath")) || DEFAULT_BASE_PATH;
  if (appsBasePathProblem(appsBasePath, basePath)) {
    throw new ConfigError("The app secrets folder setting is not valid");
  }
  return { basePath: appsBasePath, allowed: new Set(parsed.entries) };
}

/** The saved settings, or a ConfigError naming what is missing or wrong. */
export async function readConfig(ctx: PluginContext): Promise<Config> {
  const address = await ctx.settings.get<string>("address");
  const problem = addressProblem(address);
  if (problem) {
    throw new ConfigError(
      address ? `OpenBao address: ${problem}` : "OpenBao is not set up yet",
    );
  }
  const caPem = (await ctx.settings.get<string>("caPem")) ?? "";
  if (caProblem(caPem)) throw new ConfigError("The OpenBao CA is not PEM");
  const kvMount =
    (await ctx.settings.get<string>("kvMount")) || DEFAULT_KV_MOUNT;
  const basePath =
    (await ctx.settings.get<string>("basePath")) || DEFAULT_BASE_PATH;
  if (!isValidPath(kvMount) || !isValidPath(basePath)) {
    throw new ConfigError("The KV mount or base path is not valid");
  }
  const roleId = await ctx.settings.get<string>("roleId");
  if (roleIdProblem(roleId)) {
    throw new ConfigError("The AppRole role ID is not set");
  }
  const trimmed = (address as string).trim().replace(/\/+$/, "");
  return {
    address: trimmed,
    host: hostOf(trimmed),
    caPem: caPem.trim() ? caPem : null,
    kvMount,
    basePath,
    roleId: (roleId as string).trim(),
  };
}
