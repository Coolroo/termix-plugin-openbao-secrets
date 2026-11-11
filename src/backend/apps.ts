/**
 * Create-only app secrets (1.0.5): a new field at `<apps folder>/<app>/<host>`
 * in the KV mount, for another program that reads secrets from there. Off
 * until an admin sets the app secrets folder and the allowed app paths.
 *
 * Create only means: a field that exists is never replaced, and no value is
 * ever read. How:
 *
 *   1. Read the secret's metadata (versions and times, no values).
 *   2. No secret yet: write it with check-and-set 0, which OpenBao takes only
 *      while there is still no secret.
 *   3. A secret: read its field names (KV v2 subkeys, every value null) for
 *      the current version. The field is there: refuse. It is not: add it
 *      with a JSON merge patch and check-and-set = that version, so a write
 *      that happened in between makes OpenBao refuse the patch instead of
 *      the patch replacing a field it did not see.
 *
 * A lost race is tried once more from step 1. The OpenBao policy for this
 * needs create and patch on the data path and read on the subkeys and
 * metadata paths, and nothing else (docs/security.md).
 */

import type { AppsConfig } from "./config.js";
import { isAppSegment } from "./config.js";
import { CasConflictError, OpenBaoError, type OpenBao } from "./openbao.js";
import { checkValue, InputError } from "./secrets.js";

/** How many times a lost check-and-set race is tried from the start. */
export const MAX_ATTEMPTS = 2;

const FIELD = /^[A-Za-z0-9._-]{1,128}$/;

export class AppFieldError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "AppFieldError";
    this.status = status;
  }
}

export interface CreatedAppField {
  /** The secret's path, with the KV mount: `<mount>/<folder>/<app>/<host>`. */
  path: string;
  field: string;
  /** "secret" when the secret was new, "field" when a field was added. */
  created: "secret" | "field";
  /** The secret's version after the write. */
  version: number;
}

export function checkAppPart(what: "app" | "host", value: unknown): string {
  if (!isAppSegment(value)) {
    throw new InputError(
      `the ${what} is 1 to 64 letters, digits, '.', '_' and '-'`,
    );
  }
  return value;
}

export function checkField(value: unknown): string {
  if (
    typeof value !== "string" ||
    !FIELD.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new InputError(
      "the field is 1 to 128 letters, digits, '.', '_' and '-'",
    );
  }
  return value;
}

/**
 * Adds `field` with `value` at `<app>/<host>`, never replacing a field.
 * The arguments must be checked already (checkAppPart, checkField,
 * checkValue).
 */
export async function createAppField(
  deps: {
    bao: OpenBao;
    /** The settings, or null when the feature is off. */
    apps: () => Promise<AppsConfig | null>;
  },
  app: string,
  host: string,
  field: string,
  value: string,
): Promise<CreatedAppField> {
  checkValue(value);
  const config = await deps.apps();
  if (!config) {
    throw new AppFieldError(
      "creating app secrets is off: an admin sets the app secrets folder and the allowed app paths",
    );
  }
  if (!config.allowed.has(`${app}/${host}`)) {
    throw new AppFieldError(
      `${app}/${host} is not in the allowed app paths`,
      403,
    );
  }
  const path = `${config.basePath}/${app}/${host}`;
  const { kvMount } = await deps.bao.readConfig();
  const done = (created: "secret" | "field", version: number) => ({
    path: `${kvMount}/${path}`,
    field,
    created,
    version,
  });

  for (let attempt = 1; ; attempt++) {
    const last = attempt >= MAX_ATTEMPTS;
    try {
      const state = await deps.bao.versionState(path);
      if (!state) {
        return done(
          "secret",
          await deps.bao.createFields(path, { [field]: value }),
        );
      }
      if (!state.currentLive) {
        throw new AppFieldError(
          `${app}/${host} exists, but its newest version is deleted or destroyed: an OpenBao admin must restore it or delete the secret first`,
        );
      }
      const names = await deps.bao.fieldNames(path, state.currentVersion);
      if (names === null) throw new CasConflictError("Read field names");
      if (names.includes(field)) {
        throw new AppFieldError(
          `the field ${field} exists already at ${app}/${host}, and is never replaced`,
        );
      }
      return done(
        "field",
        await deps.bao.patchFields(
          path,
          { [field]: value },
          state.currentVersion,
        ),
      );
    } catch (error) {
      // A create that OpenBao refuses with 403 can mean the secret appeared
      // since step 1 (a write to an existing secret needs update, which the
      // policy does not give): look again once.
      const raced =
        error instanceof CasConflictError ||
        (error instanceof OpenBaoError &&
          error.status === 403 &&
          error.message.startsWith("Create"));
      if (raced && !last) continue;
      if (error instanceof CasConflictError) {
        throw new AppFieldError(
          `${app}/${host} changed while the field was added: try again`,
        );
      }
      throw error;
    }
  }
}
