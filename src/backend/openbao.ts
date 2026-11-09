/**
 * Talking to OpenBao (or HashiCorp Vault): AppRole login, token renewal and
 * the KV v2 calls the plugin needs.
 *
 * Every request goes through ctx.fetch: https only (the address is checked
 * in config.ts), the configured host and only that host allowed even when it
 * is private, the admin's CA when one is set and the default trust store
 * otherwise, redirects refused, and a timeout. Certificate checks are never
 * turned off.
 *
 * Errors carry an HTTP status and a short label. They never carry a secret
 * value, a token, or OpenBao's own error text, which could echo input.
 */

import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { readConfig, type Config } from "./config.js";

export const REQUEST_TIMEOUT_MS = 10_000;
/** Answers larger than this are refused rather than parsed. */
export const MAX_RESPONSE_BYTES = 1_048_576;
/** Renew when this share of the token's time has passed. */
export const RENEW_AT = 2 / 3;
/** Log in again rather than use a token this close to its end. */
export const EXPIRY_MARGIN_MS = 10_000;

export class OpenBaoError extends Error {
  constructor(
    message: string,
    /** The HTTP status OpenBao answered with, or null for no answer. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "OpenBaoError";
  }
}

/** The one message an admin sees for a spent or expired wrapping token. */
export const WRAP_TOKEN_SPENT =
  "this token was already used or has expired: make a new one";

export interface KvMetadata {
  createdTime: string | null;
  updatedTime: string | null;
  custom: Record<string, string>;
}

interface Session {
  token: string;
  /** Epoch ms. Infinity for a token without an end. */
  expiresAt: number;
  renewAt: number;
  renewable: boolean;
}

interface Answer {
  status: number;
  // OpenBao's JSON, read field by field by the callers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function describe(label: string, status: number): string {
  if (status === 403) return `${label}: OpenBao refused it (HTTP 403)`;
  return `${label} failed: HTTP ${status}`;
}

export type OpenBao = ReturnType<typeof createOpenBao>;

export function createOpenBao(deps: {
  ctx: PluginContext;
  /** The unsealed AppRole secret ID, or null when not connected. */
  secretId: () => Promise<string | null>;
  now?: () => number;
}) {
  const { ctx } = deps;
  const now = deps.now ?? Date.now;
  let session: Session | null = null;
  let loggingIn: Promise<Session> | null = null;
  let renewing: Promise<Session> | null = null;

  /** One request to OpenBao. Never throws on an HTTP status; callers decide. */
  async function send(
    config: Config,
    method: string,
    path: string,
    options: { token?: string; body?: unknown; query?: string } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = {};
    if (options.token) headers["X-Vault-Token"] = options.token;
    if (options.body !== undefined)
      headers["Content-Type"] = "application/json";
    const url = `${config.address}/v1/${encodePath(path)}${options.query ?? ""}`;
    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method,
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        timeoutMs: REQUEST_TIMEOUT_MS,
        redirect: "error",
        allowPrivateHosts: [config.host],
        ...(config.caPem ? { tls: { ca: config.caPem } } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "no answer";
      throw new OpenBaoError(`Could not reach OpenBao: ${reason}`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new OpenBaoError("OpenBao's answer was too large", response.status);
    }
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  }

  function fromAuth(auth: unknown): Session {
    const value = auth as {
      client_token?: unknown;
      lease_duration?: unknown;
      renewable?: unknown;
    } | null;
    if (!value || typeof value.client_token !== "string") {
      throw new OpenBaoError("OpenBao gave no token");
    }
    const lease = Number(value.lease_duration);
    const at = now();
    const forever = !Number.isFinite(lease) || lease <= 0;
    return {
      token: value.client_token,
      expiresAt: forever ? Infinity : at + lease * 1000,
      renewAt: forever ? Infinity : at + lease * 1000 * RENEW_AT,
      renewable: value.renewable === true,
    };
  }

  async function login(config: Config): Promise<Session> {
    const secretId = await deps.secretId();
    if (!secretId) throw new OpenBaoError("OpenBao is not connected");
    const answer = await send(config, "POST", "auth/approle/login", {
      body: { role_id: config.roleId, secret_id: secretId },
    });
    if (answer.status !== 200) {
      throw new OpenBaoError(
        describe("AppRole login", answer.status),
        answer.status,
      );
    }
    return fromAuth(answer.body?.auth);
  }

  /** Logs in once even when several requests ask at the same time. */
  async function freshSession(config: Config): Promise<Session> {
    if (!loggingIn) {
      loggingIn = login(config).finally(() => {
        loggingIn = null;
      });
    }
    session = await loggingIn;
    return session;
  }

  async function renew(config: Config, current: Session): Promise<Session> {
    const answer = await send(config, "POST", "auth/token/renew-self", {
      token: current.token,
      body: {},
    });
    if (answer.status !== 200) {
      throw new OpenBaoError(
        describe("Token renewal", answer.status),
        answer.status,
      );
    }
    return fromAuth(answer.body?.auth);
  }

  /** A token that is good for a while yet: renewed or replaced as needed. */
  async function token(config: Config): Promise<string> {
    const at = now();
    const current = session;
    if (!current || at >= current.expiresAt - EXPIRY_MARGIN_MS) {
      return (await freshSession(config)).token;
    }
    if (at >= current.renewAt) {
      // Renews once even when several requests ask at the same time.
      if (!renewing) {
        renewing = (async () => {
          if (current.renewable) {
            try {
              session = await renew(config, current);
              return session;
            } catch {
              // Past its maximum time, or revoked: log in again.
            }
          }
          return freshSession(config);
        })().finally(() => {
          renewing = null;
        });
      }
      return (await renewing).token;
    }
    return current.token;
  }

  /**
   * A request with the plugin's token. A 403 can mean the token was revoked
   * behind our back, so it logs in once more and tries again.
   */
  async function authed(
    method: string,
    path: string,
    options: { body?: unknown; query?: string } = {},
  ): Promise<Answer> {
    const config = await readConfig(ctx);
    let answer = await send(config, method, path, {
      ...options,
      token: await token(config),
    });
    if (answer.status === 403) {
      session = null;
      answer = await send(config, method, path, {
        ...options,
        token: (await freshSession(config)).token,
      });
    }
    return answer;
  }

  const dataPath = (config: Config, path: string) =>
    `${config.kvMount}/data/${path}`;
  const metadataPath = (config: Config, path: string) =>
    `${config.kvMount}/metadata/${path}`;

  return {
    readConfig: () => readConfig(ctx),

    /**
     * Unwraps a response-wrapped token once and returns the AppRole secret ID
     * inside it. A spent or expired token gives WRAP_TOKEN_SPENT.
     */
    async unwrap(wrappingToken: string): Promise<string> {
      const config = await readConfig(ctx);
      const answer = await send(config, "POST", "sys/wrapping/unwrap", {
        token: wrappingToken,
        body: {},
      });
      if (
        answer.status === 400 ||
        answer.status === 403 ||
        answer.status === 404
      ) {
        throw new OpenBaoError(WRAP_TOKEN_SPENT, answer.status);
      }
      if (answer.status !== 200) {
        throw new OpenBaoError(
          describe("Unwrap", answer.status),
          answer.status,
        );
      }
      const secretId = answer.body?.data?.secret_id;
      if (typeof secretId !== "string" || !secretId) {
        throw new OpenBaoError(
          "The wrapped answer holds no AppRole secret ID: wrap the output of auth/approle/role/<role>/secret-id",
        );
      }
      return secretId;
    },

    /** Logs in now, for Test connection. Returns how long the token lasts. */
    async login(): Promise<{ ttlSeconds: number | null }> {
      const config = await readConfig(ctx);
      session = null;
      const fresh = await freshSession(config);
      return {
        ttlSeconds:
          fresh.expiresAt === Infinity
            ? null
            : Math.round((fresh.expiresAt - now()) / 1000),
      };
    },

    /** Forgets the token, after a disconnect or a settings change. */
    reset(): void {
      session = null;
    },

    /** Revokes the token at OpenBao, best effort, and forgets it. */
    async revoke(): Promise<void> {
      const current = session;
      session = null;
      if (!current) return;
      try {
        const config = await readConfig(ctx);
        await send(config, "POST", "auth/token/revoke-self", {
          token: current.token,
          body: {},
        });
      } catch {
        // The token runs out on its own.
      }
    },

    /** Writes the value as a new version of the secret. */
    async write(path: string, value: string): Promise<void> {
      const config = await readConfig(ctx);
      const answer = await authed("POST", dataPath(config, path), {
        body: { data: { value } },
      });
      if (answer.status !== 200 && answer.status !== 204) {
        throw new OpenBaoError(describe("Write", answer.status), answer.status);
      }
    },

    /** The secret's value, or null when there is none. */
    async read(path: string): Promise<string | null> {
      const config = await readConfig(ctx);
      const answer = await authed("GET", dataPath(config, path));
      if (answer.status === 404) return null;
      if (answer.status !== 200) {
        throw new OpenBaoError(describe("Read", answer.status), answer.status);
      }
      const value = answer.body?.data?.data?.value;
      return typeof value === "string" ? value : null;
    },

    async readMetadata(path: string): Promise<KvMetadata | null> {
      const config = await readConfig(ctx);
      const answer = await authed("GET", metadataPath(config, path));
      if (answer.status === 404) return null;
      if (answer.status !== 200) {
        throw new OpenBaoError(
          describe("Read metadata", answer.status),
          answer.status,
        );
      }
      const data = answer.body?.data ?? {};
      const custom: Record<string, string> = {};
      if (data.custom_metadata && typeof data.custom_metadata === "object") {
        for (const [key, value] of Object.entries(data.custom_metadata)) {
          if (typeof value === "string") custom[key] = value;
        }
      }
      return {
        createdTime:
          typeof data.created_time === "string" ? data.created_time : null,
        updatedTime:
          typeof data.updated_time === "string" ? data.updated_time : null,
        custom,
      };
    },

    /** Replaces the secret's custom metadata. */
    async writeMetadata(
      path: string,
      custom: Record<string, string>,
    ): Promise<void> {
      const config = await readConfig(ctx);
      const answer = await authed("POST", metadataPath(config, path), {
        body: { custom_metadata: custom },
      });
      if (answer.status !== 200 && answer.status !== 204) {
        throw new OpenBaoError(
          describe("Write metadata", answer.status),
          answer.status,
        );
      }
    },

    /** The keys one level under a folder; folders end with "/". */
    async list(path: string): Promise<string[]> {
      const config = await readConfig(ctx);
      const answer = await authed("GET", metadataPath(config, path), {
        query: "?list=true",
      });
      if (answer.status === 404) return [];
      if (answer.status !== 200) {
        throw new OpenBaoError(describe("List", answer.status), answer.status);
      }
      const keys = answer.body?.data?.keys;
      return Array.isArray(keys)
        ? keys.filter((key): key is string => typeof key === "string")
        : [];
    },

    /** Deletes the secret with every version and its metadata. */
    async destroy(path: string): Promise<void> {
      const config = await readConfig(ctx);
      const answer = await authed("DELETE", metadataPath(config, path));
      if (
        answer.status !== 200 &&
        answer.status !== 204 &&
        answer.status !== 404
      ) {
        throw new OpenBaoError(
          describe("Delete", answer.status),
          answer.status,
        );
      }
    },
  };
}
