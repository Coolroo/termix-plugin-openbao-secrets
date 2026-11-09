/**
 * Secrets by area and name, on top of the KV v2 calls in openbao.ts.
 *
 * Layout under the admin's KV mount and base path:
 *   <basePath>/users/<user id>/<name>      a person's own secrets
 *   <basePath>/shared/<name>               shared secrets
 *   <basePath>/plugins/<plugin id>/<name>  one consumer plugin's area
 *
 * The value is the KV field "value". Custom metadata holds createdBy, and
 * optionally expiresAt (ISO time) and note (short, not secret). A delete
 * removes the metadata, which removes every version.
 *
 * Nothing here checks permissions or writes the audit: the routes and the
 * service do, each for its own callers.
 */

import { createHash } from "node:crypto";
import {
  isValidName,
  MAX_NOTE_LENGTH,
  MAX_SEGMENTS,
  MAX_VALUE_LENGTH,
  normalizePrefix,
  underPrefix,
} from "../shared/names.js";
import type { OpenBao } from "./openbao.js";

export type AreaRef =
  | { kind: "user"; userId: string }
  | { kind: "shared" }
  | { kind: "plugin"; pluginId: string };

export interface SecretEntry {
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  expiresAt: string | null;
  note: string | null;
}

export interface PutOptions {
  expiresAt?: string | null;
  note?: string | null;
}

export class InputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "InputError";
    this.status = status;
  }
}

/** Most secrets one listing walks, so a huge area cannot stall a request. */
export const MAX_LIST = 2000;

/** The furthest ahead an expiresAt may be. */
export const MAX_EXPIRY_DAYS = 30;
const MAX_EXPIRY_MS = MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A user or plugin id as one path segment. Ids that are not plain are
 * hashed, so no id can add a "/" or a ".." to the path.
 */
export function idSegment(id: string): string {
  return SAFE_ID.test(id)
    ? id
    : `h-${createHash("sha256").update(id).digest("hex")}`;
}

export function areaRoot(basePath: string, area: AreaRef): string {
  switch (area.kind) {
    case "user":
      return `${basePath}/users/${idSegment(area.userId)}`;
    case "shared":
      return `${basePath}/shared`;
    case "plugin":
      return `${basePath}/plugins/${idSegment(area.pluginId)}`;
  }
}

export function checkName(name: unknown): string {
  if (!isValidName(name)) {
    throw new InputError(
      `a name is 1 to ${MAX_SEGMENTS} parts of letters, digits, '.', '_' and '-' joined by '/', at most 200 characters`,
    );
  }
  return name;
}

export function checkPrefix(prefix: unknown): string {
  const normalized = normalizePrefix(prefix);
  if (normalized === null) {
    throw new InputError("the prefix is not a valid folder name");
  }
  return normalized;
}

export function checkValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError("the value is empty");
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new InputError(
      `the value is longer than ${MAX_VALUE_LENGTH} characters`,
    );
  }
  return value;
}

function checkOptions(
  options: unknown,
  now: number,
): { expiresAt: string | null; note: string | null } {
  const value = (options ?? {}) as PutOptions;
  if (typeof value !== "object")
    throw new InputError("options must be an object");
  let expiresAt: string | null = null;
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    const at =
      typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
    if (!Number.isFinite(at)) {
      throw new InputError("expiresAt must be an ISO time");
    }
    if (at <= now) throw new InputError("expiresAt is in the past");
    if (at - now > MAX_EXPIRY_MS) {
      throw new InputError(
        `expiresAt is more than ${MAX_EXPIRY_DAYS} days ahead: the limit is ${MAX_EXPIRY_DAYS} days`,
      );
    }
    expiresAt = new Date(at).toISOString();
  }
  let note: string | null = null;
  if (value.note !== undefined && value.note !== null) {
    if (typeof value.note !== "string" || value.note.length > MAX_NOTE_LENGTH) {
      throw new InputError(
        `a note is text of at most ${MAX_NOTE_LENGTH} characters`,
      );
    }
    note = value.note.trim() || null;
  }
  return { expiresAt, note };
}

function expired(entry: { expiresAt: string | null }, now: number): boolean {
  if (!entry.expiresAt) return false;
  const at = Date.parse(entry.expiresAt);
  return Number.isFinite(at) && at <= now;
}

export type Secrets = ReturnType<typeof createSecrets>;

export function createSecrets(bao: OpenBao, clock: () => number = Date.now) {
  async function root(area: AreaRef): Promise<string> {
    const config = await bao.readConfig();
    return areaRoot(config.basePath, area);
  }

  async function entryAt(
    path: string,
    name: string,
  ): Promise<SecretEntry | null> {
    const meta = await bao.readMetadata(path);
    if (!meta) return null;
    return {
      name,
      createdAt: meta.createdTime,
      updatedAt: meta.updatedTime,
      createdBy: meta.custom.createdBy ?? null,
      expiresAt: meta.custom.expiresAt ?? null,
      note: meta.custom.note ?? null,
    };
  }

  /** Every name under a folder of the area, depth first, at most MAX_LIST. */
  async function walk(
    base: string,
    folder: string,
    depth: number,
  ): Promise<string[]> {
    const names: string[] = [];
    const keys = await bao.list(folder ? `${base}/${folder}` : base);
    for (const key of keys.sort()) {
      if (names.length >= MAX_LIST) break;
      const isFolder = key.endsWith("/");
      const segment = isFolder ? key.slice(0, -1) : key;
      const name = folder ? `${folder}/${segment}` : segment;
      // Anything that is not a name this plugin could have written is left
      // alone: it was put there some other way.
      if (!isValidName(name)) continue;
      if (isFolder) {
        if (depth + 1 < MAX_SEGMENTS) {
          names.push(...(await walk(base, name, depth + 1)));
        }
      } else {
        names.push(name);
      }
    }
    return names.slice(0, MAX_LIST);
  }

  async function list(area: AreaRef, prefix = ""): Promise<SecretEntry[]> {
    const base = await root(area);
    const now = clock();
    const out: SecretEntry[] = [];
    // The prefix itself can be a secret as well as a folder.
    if (prefix) {
      const own = await entryAt(`${base}/${prefix}`, prefix);
      if (own && !expired(own, now)) out.push(own);
    }
    const depth = prefix ? prefix.split("/").length : 0;
    const names =
      depth < MAX_SEGMENTS
        ? (await walk(base, prefix, depth)).filter((name) =>
            underPrefix(name, prefix),
          )
        : [];
    for (const name of names) {
      if (out.length >= MAX_LIST) break;
      const entry = await entryAt(`${base}/${name}`, name);
      if (entry && !expired(entry, now)) out.push(entry);
    }
    return out;
  }

  return {
    list,

    /** Stores the value. Keeps createdBy when the secret already exists. */
    async put(
      area: AreaRef,
      name: string,
      value: string,
      options: unknown,
      actor: string,
    ): Promise<SecretEntry> {
      checkName(name);
      checkValue(value);
      const { expiresAt, note } = checkOptions(options, clock());
      const path = `${await root(area)}/${name}`;
      const existing = await bao.readMetadata(path);
      await bao.write(path, value);
      const custom: Record<string, string> = {
        createdBy: existing?.custom.createdBy ?? actor,
      };
      if (expiresAt) custom.expiresAt = expiresAt;
      if (note) custom.note = note;
      await bao.writeMetadata(path, custom);
      return (
        (await entryAt(path, name)) ?? {
          name,
          createdAt: null,
          updatedAt: null,
          createdBy: custom.createdBy,
          expiresAt,
          note,
        }
      );
    },

    /** The entry without its value, or null (also when it has expired). */
    async describe(area: AreaRef, name: string): Promise<SecretEntry | null> {
      checkName(name);
      const entry = await entryAt(`${await root(area)}/${name}`, name);
      return entry && !expired(entry, clock()) ? entry : null;
    },

    /** The value, or null. An expired secret is deleted and reads as null. */
    async get(area: AreaRef, name: string): Promise<string | null> {
      checkName(name);
      const path = `${await root(area)}/${name}`;
      const meta = await bao.readMetadata(path);
      if (!meta) return null;
      if (expired({ expiresAt: meta.custom.expiresAt ?? null }, clock())) {
        await bao.destroy(path);
        return null;
      }
      return bao.read(path);
    },

    /** Deletes every version. Returns whether there was a secret. */
    async remove(area: AreaRef, name: string): Promise<boolean> {
      checkName(name);
      const path = `${await root(area)}/${name}`;
      const meta = await bao.readMetadata(path);
      if (!meta) return false;
      await bao.destroy(path);
      return true;
    },

    /** Deletes every secret at or under the prefix. Returns how many. */
    async removePrefix(area: AreaRef, prefix: string): Promise<number> {
      const base = await root(area);
      const entries = await list(area, prefix);
      for (const entry of entries) await bao.destroy(`${base}/${entry.name}`);
      return entries.length;
    },

    /**
     * Deletes every secret whose expiresAt has passed, in every area under
     * the base path. Returns the paths deleted, relative to the base path.
     */
    async sweep(): Promise<string[]> {
      const config = await bao.readConfig();
      const now = clock();
      const removed: string[] = [];
      const roots: string[] = [`${config.basePath}/shared`];
      for (const group of ["users", "plugins"]) {
        for (const key of await bao.list(`${config.basePath}/${group}`)) {
          if (key.endsWith("/") && /^[A-Za-z0-9_-]+\/$/.test(key)) {
            roots.push(`${config.basePath}/${group}/${key.slice(0, -1)}`);
          }
        }
      }
      for (const base of roots) {
        for (const name of await walk(base, "", 0)) {
          const path = `${base}/${name}`;
          const meta = await bao.readMetadata(path);
          if (
            meta &&
            expired({ expiresAt: meta.custom.expiresAt ?? null }, now)
          ) {
            await bao.destroy(path);
            removed.push(path.slice(config.basePath.length + 1));
          }
        }
      }
      return removed;
    },
  };
}
