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
  return errors;
}

export class ConfigError extends Error {
  readonly status = 409;
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
