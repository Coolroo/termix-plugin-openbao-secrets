import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import { inject } from "light-my-request";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import type { SecretsStore } from "../../src/backend/service";

export const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
export const manifest = manifestJson as unknown as PluginManifest;

export const ADDRESS = "https://bao.internal:8200";
export const ROLE_ID = "role-1";
export const SECRET_ID = "secret-id-1";

export const USE = "openbao-secrets.use";
export const MANAGE_SHARED = "openbao-secrets.manage-shared";
export const ADMIN = "admin.plugins.manage";
export const ALL_PERMISSIONS = [USE, MANAGE_SHARED, ADMIN];

interface KvEntry {
  value: string;
  versions: number;
  created: string;
  updated: string;
  custom: Record<string, string>;
}

interface Token {
  expiresAt: number;
  renewable: boolean;
  revoked: boolean;
}

export interface BaoCall {
  method: string;
  path: string;
  query: string;
  token: string | null;
  init?: PluginFetchInit;
}

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A small OpenBao in memory: response wrapping, AppRole login, token
 * renew and revoke, and KV v2 data and metadata. It answers ctx.fetch.
 */
export class FakeBao {
  readonly kv = new Map<string, KvEntry>();
  readonly wrapped = new Map<string, string>();
  readonly tokens = new Map<string, Token>();
  readonly calls: BaoCall[] = [];
  secretIds = new Set<string>([SECRET_ID]);
  leaseSeconds = 3600;
  renewable = true;
  /** Renewal is refused: the token reached its maximum time. */
  refuseRenew = false;
  /** Every KV call answers this status instead, when set. */
  failKv: number | null = null;
  private counter = 0;

  /** A wrapping token that unwraps once to `secretId`. */
  wrap(secretId = SECRET_ID): string {
    const token = `hvs.wrap-${++this.counter}`;
    this.wrapped.set(token, secretId);
    return token;
  }

  private issue(): Response {
    const token = `hvs.token-${++this.counter}`;
    this.tokens.set(token, {
      expiresAt: Date.now() + this.leaseSeconds * 1000,
      renewable: this.renewable,
      revoked: false,
    });
    return reply(200, {
      auth: {
        client_token: token,
        lease_duration: this.leaseSeconds,
        renewable: this.renewable,
      },
    });
  }

  private valid(token: string | null): Token | null {
    if (!token) return null;
    const found = this.tokens.get(token);
    if (!found || found.revoked || found.expiresAt <= Date.now()) return null;
    return found;
  }

  /** Paths of the secrets stored, relative to the mount, sorted. */
  paths(): string[] {
    return [...this.kv.keys()].sort();
  }

  calledPaths(): string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  fetch = async (url: string, init?: PluginFetchInit): Promise<Response> => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const token = init?.headers?.["X-Vault-Token"] ?? null;
    const path = decodeURIComponent(parsed.pathname.replace(/^\/v1\//, ""));
    this.calls.push({ method, path, query: parsed.search, token, init });
    const body = init?.body ? JSON.parse(init.body) : {};

    if (path === "sys/wrapping/unwrap") {
      const secretId = token ? this.wrapped.get(token) : undefined;
      if (!token || secretId === undefined) {
        return reply(400, {
          errors: ["wrapping token is not valid or does not exist"],
        });
      }
      this.wrapped.delete(token);
      return reply(200, {
        data: { secret_id: secretId, secret_id_accessor: "acc" },
      });
    }
    if (path === "auth/approle/login") {
      if (body.role_id !== ROLE_ID || !this.secretIds.has(body.secret_id)) {
        return reply(400, { errors: ["invalid role or secret ID"] });
      }
      return this.issue();
    }
    if (path === "auth/token/renew-self") {
      const found = this.valid(token);
      if (!found || !found.renewable || this.refuseRenew) {
        return reply(403, { errors: ["permission denied"] });
      }
      found.expiresAt = Date.now() + this.leaseSeconds * 1000;
      return reply(200, {
        auth: {
          client_token: token,
          lease_duration: this.leaseSeconds,
          renewable: true,
        },
      });
    }
    if (path === "auth/token/revoke-self") {
      const found = token ? this.tokens.get(token) : undefined;
      if (found) found.revoked = true;
      return reply(204);
    }

    if (!this.valid(token))
      return reply(403, { errors: ["permission denied"] });
    if (this.failKv !== null) return reply(this.failKv, { errors: ["boom"] });

    const data = path.match(/^([^/]+)\/data\/(.+)$/);
    const meta = path.match(/^([^/]+)\/metadata\/(.+)$/);
    const now = new Date().toISOString();
    if (data) {
      const key = data[2];
      if (method === "GET") {
        const entry = this.kv.get(key);
        if (!entry) return reply(404, { errors: [] });
        return reply(200, { data: { data: { value: entry.value } } });
      }
      if (method === "POST") {
        const existing = this.kv.get(key);
        this.kv.set(key, {
          value: body.data.value,
          versions: (existing?.versions ?? 0) + 1,
          created: existing?.created ?? now,
          updated: now,
          custom: existing?.custom ?? {},
        });
        return reply(200, { data: { version: 1 } });
      }
    }
    if (meta) {
      const key = meta[2];
      if (method === "GET" && parsed.searchParams.get("list") === "true") {
        const prefix = `${key.replace(/\/$/, "")}/`;
        const keys = new Set<string>();
        for (const stored of this.kv.keys()) {
          if (!stored.startsWith(prefix)) continue;
          const rest = stored.slice(prefix.length);
          const slash = rest.indexOf("/");
          keys.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
        }
        if (keys.size === 0) return reply(404, { errors: [] });
        return reply(200, { data: { keys: [...keys].sort() } });
      }
      if (method === "GET") {
        const entry = this.kv.get(key);
        if (!entry) return reply(404, { errors: [] });
        return reply(200, {
          data: {
            created_time: entry.created,
            updated_time: entry.updated,
            custom_metadata: entry.custom,
          },
        });
      }
      if (method === "POST") {
        const entry = this.kv.get(key);
        if (entry) entry.custom = { ...body.custom_metadata };
        return reply(204);
      }
      if (method === "DELETE") {
        this.kv.delete(key);
        return reply(204);
      }
    }
    return reply(404, { errors: ["no handler"] });
  };
}

export interface Reply {
  status: number;
  // Route bodies vary per test; asserting on them is the point.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
}

export interface TestServer {
  db: TestDb;
  mock: MockPluginContext;
  bao: FakeBao;
  /** As a signed-in person (default alice). */
  call: (
    method: string,
    path: string,
    body?: unknown,
    options?: { user?: string | null; apiKey?: boolean },
  ) => Promise<Reply>;
  /** The provided service, called as `user`. */
  service: <T>(
    user: string,
    fn: (store: SecretsStore) => Promise<T>,
  ) => Promise<T>;
  /** Connects with a fresh wrapping token, as alice the admin would. */
  connect: () => Promise<void>;
  /** Stands in for another plugin's ctx.registry.provide. */
  provideAsConsumer: (key: string, value: unknown) => void;
  close: () => Promise<void>;
}

/**
 * The plugin activated against a real in-memory database and the fake
 * OpenBao, its router served the way core serves it.
 */
export async function startServer(
  options: {
    permissions?: string[];
    settings?: Record<string, unknown>;
    bao?: FakeBao;
    /** Starts with a secret ID stored, as an earlier Connect left it. */
    connected?: boolean;
  } = {},
): Promise<TestServer> {
  const db = await createTestDb(pluginDir);
  for (const user of ["alice", "bob"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  const bao = options.bao ?? new FakeBao();
  if (options.connected) {
    // How the mock ctx.secrets.seal seals.
    const sealed = `sealed:${Buffer.from(SECRET_ID).toString("base64")}`;
    db.sqlite
      .prepare(
        "INSERT INTO p_openbao_secrets_state (name, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("secret-id", sealed, "alice", new Date().toISOString());
  }
  let router: Router | null = null;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ALL_PERMISSIONS,
    settings: options.settings ?? { address: ADDRESS, roleId: ROLE_ID },
    fetch: bao.fetch,
  });

  // Core keeps one registry for every plugin. The mock keeps one per
  // context, so other plugins' keys are kept here and read first.
  const others = new Map<string, unknown>();
  const registry = mock.ctx.registry as { consume: (key: string) => unknown };
  const consume = registry.consume.bind(registry);
  registry.consume = (key: string) =>
    others.has(key) ? others.get(key) : consume(key);

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.header("x-test-user");
    if (req.header("x-test-api-key")) {
      (req as unknown as { apiKeyId: string }).apiKeyId = "key-1";
    }
    mock.setActor(user || undefined);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));

  const server: TestServer = {
    db,
    mock,
    bao,
    call: async (method, path, body, opts = {}) => {
      const user = opts.user === undefined ? "alice" : opts.user;
      const response = await inject(app, {
        method: method as "GET",
        url: path,
        headers: {
          ...(user ? { "x-test-user": user } : {}),
          ...(opts.apiKey ? { "x-test-api-key": "1" } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let parsed: unknown = null;
      try {
        parsed = response.payload ? JSON.parse(response.payload) : null;
      } catch {
        parsed = response.payload;
      }
      return {
        status: response.statusCode,
        body: parsed,
        headers: response.headers,
      };
    },
    service: (user, fn) =>
      mock.actAs(user, () =>
        fn(mock.services.get("openbao-secrets.store") as SecretsStore),
      ),
    connect: async () => {
      const made = await server.call("POST", "/admin/connect", {
        wrappingToken: bao.wrap(),
      });
      if (made.status !== 200) throw new Error(JSON.stringify(made.body));
    },
    provideAsConsumer: (key, value) => {
      others.set(key, value);
    },
    close: async () => {
      for (const dispose of [...mock.disposals].reverse()) {
        await Promise.resolve(dispose()).catch(() => {});
      }
      db.close();
    },
  };
  return server;
}

/** Every audit line as text, without the request object each may carry. */
export function auditText(server: TestServer): string {
  return JSON.stringify(
    server.mock.audits.map(({ request: _request, ...line }) => line),
  );
}
