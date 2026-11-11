import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ALLOWED_APP_PATHS,
  parseAllowedAppPaths,
  validateSettings,
} from "../../src/backend/config";
import {
  ADDRESS,
  APPS_FOLDER,
  auditText,
  CREATE_APP_SECRETS,
  MANAGE_SHARED,
  ROLE_ID,
  startServer,
  USE,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const VALUE = "app-s3cret-value";
const KEY = "my-app/host-1";

async function withApps(
  options: {
    allowed?: string;
    folder?: string;
    permissions?: string[];
  } = {},
): Promise<TestServer> {
  return startServer({
    connected: true,
    settings: {
      address: ADDRESS,
      roleId: ROLE_ID,
      appsBasePath: options.folder ?? APPS_FOLDER,
      allowedAppPaths: options.allowed ?? "my-app/host-1\nother.app/host_2",
    },
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });
}

/** A consumer plugin's side of the handshake (docs/service.md). */
async function bindAs(
  made: TestServer,
  pluginId: string,
): Promise<{ plugin: string; key: string }> {
  let expecting = true;
  let key: string | null = null;
  made.provideAsConsumer(`${pluginId}.secretsStoreKey`, (given: string) => {
    if (!expecting) throw new Error("not binding");
    key = given;
  });
  await made.service("alice", (store) => store.bindPlugin(pluginId));
  expecting = false;
  if (!key) throw new Error("no key");
  return { plugin: pluginId, key };
}

function appCalls(made: TestServer): string[] {
  return made.bao.calls
    .filter((call) => call.path.includes(`/${APPS_FOLDER}/`))
    .map((call) => `${call.method} ${call.path}${call.query}`);
}

function lastAppAudit(made: TestServer) {
  const lines = made.mock.audits.filter(
    (line) => line.action === "openbao_secrets_service_createAppField",
  );
  return lines[lines.length - 1];
}

describe("app paths settings", () => {
  it("parses one <app>/<host> per line or comma, skipping blanks and repeats", () => {
    expect(parseAllowedAppPaths(" a/b \n\nc.d/e_f-1, a/b\r\n")).toEqual({
      entries: ["a/b", "c.d/e_f-1"],
      problem: null,
    });
    expect(parseAllowedAppPaths("")).toEqual({ entries: [], problem: null });
    expect(parseAllowedAppPaths(undefined)).toEqual({
      entries: [],
      problem: null,
    });
  });

  it("refuses entries that are not exactly <app>/<host>", () => {
    for (const bad of [
      "a",
      "a/b/c",
      "/b",
      "a/",
      "a/..",
      "../b",
      "a b/c",
      "a/b*",
      "a/b?x",
      `${"x".repeat(65)}/b`,
    ]) {
      expect(parseAllowedAppPaths(bad).problem, bad).toMatch(
        /is not <app>\/<host>/,
      );
    }
    expect(parseAllowedAppPaths(42).problem).toBe(
      "Enter one <app>/<host> per line",
    );
    const many = Array.from(
      { length: MAX_ALLOWED_APP_PATHS + 1 },
      (_, index) => `app-${index}/host`,
    ).join("\n");
    expect(parseAllowedAppPaths(many).problem).toMatch(/At most/);
  });

  it("validates both settings on save, and keeps the folder outside the base path", () => {
    expect(
      validateSettings({ appsBasePath: "apps", allowedAppPaths: "a/b" }),
    ).toEqual({});
    expect(validateSettings({ appsBasePath: "", allowedAppPaths: "" })).toEqual(
      {},
    );
    expect(
      validateSettings({ appsBasePath: "a/../b", allowedAppPaths: "a/b/c" }),
    ).toEqual({
      appsBasePath: expect.stringMatching(/one to four parts/),
      allowedAppPaths: expect.stringMatching(/is not <app>\/<host>/),
    });
    for (const [appsBasePath, basePath] of [
      ["termix", undefined],
      ["termix/apps", undefined],
      ["vault", "vault/termix"],
      ["same", "same"],
    ]) {
      expect(
        validateSettings({ appsBasePath, basePath }).appsBasePath,
        `${appsBasePath} vs ${basePath}`,
      ).toMatch(/outside the base path/);
    }
  });
});

describe("createAppField", () => {
  it("is off until both settings are set, and then makes no OpenBao call", async () => {
    for (const settings of [
      {},
      { appsBasePath: APPS_FOLDER },
      { allowedAppPaths: KEY },
    ]) {
      server = await startServer({
        connected: true,
        settings: { address: ADDRESS, roleId: ROLE_ID, ...settings },
      });
      const caller = await bindAs(server, "runbooks");
      const error = await server
        .service("alice", (store) =>
          store.createAppField(caller, "my-app", "host-1", "token", VALUE),
        )
        .catch((caught: Error) => caught);
      expect((error as Error).message).toMatch(/creating app secrets is off/);
      expect(appCalls(server)).toEqual([]);
      await server.close();
      server = null;
    }
  });

  it("refuses a path that is not allowed, without an OpenBao call", async () => {
    server = await withApps();
    const caller = await bindAs(server, "runbooks");
    for (const [app, host] of [
      ["my-app", "host-2"],
      ["other", "host-1"],
    ]) {
      const error = await server
        .service("alice", (store) =>
          store.createAppField(caller, app, host, "token", VALUE),
        )
        .catch((caught: Error) => caught);
      expect((error as Error).message).toBe(
        `${app}/${host} is not in the allowed app paths`,
      );
    }
    expect(appCalls(server)).toEqual([]);
  });

  it("creates a new secret with check-and-set 0", async () => {
    server = await withApps();
    const caller = await bindAs(server, "runbooks");
    const result = await server.service("alice", (store) =>
      store.createAppField(caller, "my-app", "host-1", "token", VALUE),
    );
    expect(result).toEqual({
      path: `kv/${APPS_FOLDER}/my-app/host-1`,
      field: "token",
      created: "secret",
      version: 1,
    });
    expect(server.bao.appData(KEY)).toEqual({ token: VALUE });
    expect(appCalls(server)).toEqual([
      `GET kv/metadata/${APPS_FOLDER}/my-app/host-1`,
      `POST kv/data/${APPS_FOLDER}/my-app/host-1`,
    ]);
    const post = server.bao.calls.find(
      (call) => call.method === "POST" && call.path.startsWith("kv/data/apps"),
    );
    expect(JSON.parse(post!.init!.body as string).options).toEqual({ cas: 0 });
  });

  it("adds a new field to an existing secret with a merge patch at the current version", async () => {
    server = await withApps();
    server.bao.writeApp(KEY, { a: "1" });
    server.bao.writeApp(KEY, { a: "1", "hub.pub": "2" });
    const caller = await bindAs(server, "runbooks");
    const result = await server.service("alice", (store) =>
      store.createAppField(caller, "my-app", "host-1", "token", VALUE),
    );
    expect(result).toMatchObject({ created: "field", version: 3 });
    expect(server.bao.appData(KEY)).toEqual({
      a: "1",
      "hub.pub": "2",
      token: VALUE,
    });
    expect(appCalls(server)).toEqual([
      `GET kv/metadata/${APPS_FOLDER}/my-app/host-1`,
      `GET kv/subkeys/${APPS_FOLDER}/my-app/host-1?version=2&depth=1`,
      `PATCH kv/data/${APPS_FOLDER}/my-app/host-1`,
    ]);
    const patch = server.bao.calls.find((call) => call.method === "PATCH")!;
    expect(patch.init!.headers!["Content-Type"]).toBe(
      "application/merge-patch+json",
    );
    expect(JSON.parse(patch.init!.body as string)).toEqual({
      options: { cas: 2 },
      data: { token: VALUE },
    });
  });

  it("refuses a field that exists, and never reads or replaces it", async () => {
    server = await withApps();
    const caller = await bindAs(server, "runbooks");
    await server.service("alice", (store) =>
      store.createAppField(caller, "my-app", "host-1", "token", "first"),
    );
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      "the field token exists already at my-app/host-1, and is never replaced",
    );
    expect(server.bao.appData(KEY)).toEqual({ token: "first" });
    const calls = appCalls(server);
    expect(calls.filter((call) => call.startsWith("PATCH"))).toEqual([]);
    expect(calls.filter((call) => call.startsWith("GET kv/data"))).toEqual([]);
  });

  it("tries again when another write lands first, and then refuses that field", async () => {
    server = await withApps();
    server.bao.writeApp(KEY, { a: "1" });
    const caller = await bindAs(server, "runbooks");
    let raced = false;
    server.bao.beforeAppWrite = (method, key) => {
      if (raced) return;
      raced = true;
      server!.bao.writeApp(key, { a: "1", token: "theirs" });
    };
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(/exists already/);
    expect(server.bao.appData(KEY)).toEqual({ a: "1", token: "theirs" });
  });

  it("tries again when another field lands first, and keeps both", async () => {
    server = await withApps();
    server.bao.writeApp(KEY, { a: "1" });
    const caller = await bindAs(server, "runbooks");
    let raced = false;
    server.bao.beforeAppWrite = (method, key) => {
      if (raced) return;
      raced = true;
      server!.bao.writeApp(key, { a: "1", b: "2" });
    };
    const result = await server.service("alice", (store) =>
      store.createAppField(caller, "my-app", "host-1", "token", VALUE),
    );
    expect(result).toMatchObject({ created: "field", version: 3 });
    expect(server.bao.appData(KEY)).toEqual({ a: "1", b: "2", token: VALUE });
  });

  it("tries again when the secret is created between the check and the create", async () => {
    server = await withApps();
    const caller = await bindAs(server, "runbooks");
    let raced = false;
    server.bao.beforeAppWrite = (method, key) => {
      if (raced) return;
      raced = true;
      server!.bao.writeApp(key, { other: "x" });
    };
    const result = await server.service("alice", (store) =>
      store.createAppField(caller, "my-app", "host-1", "token", VALUE),
    );
    expect(result).toMatchObject({ created: "field", version: 2 });
    expect(server.bao.appData(KEY)).toEqual({ other: "x", token: VALUE });
  });

  it("gives up after a second lost race, without writing", async () => {
    server = await withApps();
    server.bao.writeApp(KEY, { a: "1" });
    const caller = await bindAs(server, "runbooks");
    let n = 0;
    server.bao.beforeAppWrite = (method, key) => {
      server!.bao.writeApp(key, { a: "1", [`n${++n}`]: "x" });
    };
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      "my-app/host-1 changed while the field was added: try again",
    );
    expect(server.bao.appData(KEY)).not.toHaveProperty("token");
    expect(n).toBe(2);
  });

  it("refuses a secret whose newest version is deleted", async () => {
    server = await withApps();
    server.bao.writeApp(KEY, { a: "1" });
    server.bao.apps.get(KEY)!.versions[0].deleted = true;
    const caller = await bindAs(server, "runbooks");
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(
      /newest version is deleted or destroyed/,
    );
    expect(appCalls(server)).toEqual([
      `GET kv/metadata/${APPS_FOLDER}/my-app/host-1`,
    ]);
  });

  it("checks the app, host, field and value", async () => {
    server = await withApps({ allowed: "a/b" });
    const caller = await bindAs(server, "runbooks");
    const cases: Array<[string, string, string, unknown, RegExp]> = [
      ["a/x", "b", "f", VALUE, /the app is/],
      ["a", "..", "f", VALUE, /the host is/],
      ["a", "b", "f/g", VALUE, /the field is/],
      ["a", "b", "", VALUE, /the field is/],
      ["a", "b", "f", "", /the value is empty/],
      ["a", "b", "f", 7, /the value is empty/],
    ];
    for (const [app, host, field, value, message] of cases) {
      const error = await server
        .service("alice", (store) =>
          store.createAppField(caller, app, host, field, value as string),
        )
        .catch((caught: Error) => caught);
      expect((error as Error).message).toMatch(message);
    }
    expect(appCalls(server)).toEqual([]);
  });

  it("is only for plugins bound to the store", async () => {
    server = await withApps();
    const caller = await bindAs(server, "runbooks");
    const tries: unknown[] = [
      "user",
      "shared",
      null,
      { plugin: "runbooks", key: "0".repeat(64) },
      { plugin: "other", key: caller.key },
    ];
    for (const area of tries) {
      const error = await server
        .service("alice", (store) =>
          store.createAppField(
            area as { plugin: string; key: string },
            "my-app",
            "host-1",
            "token",
            VALUE,
          ),
        )
        .catch((caught: Error) => caught);
      expect(error, JSON.stringify(area)).toBeInstanceOf(Error);
    }
    expect(appCalls(server)).toEqual([]);
  });

  it("needs Create app secrets as well as Use secrets", async () => {
    server = await withApps({ permissions: [USE, MANAGE_SHARED] });
    const caller = await bindAs(server, "runbooks");
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      "you need the Create app secrets permission",
    );
    expect(appCalls(server)).toEqual([]);
    expect(CREATE_APP_SECRETS).toBe("openbao-secrets.create-app-secrets");
  });

  it("writes an audit line with the user, the plugin, the path and the field, never the value", async () => {
    server = await withApps();
    const caller = await bindAs(server, "runbooks");
    await server.service("alice", (store) =>
      store.createAppField(caller, "my-app", "host-1", "token", VALUE),
    );
    expect(lastAppAudit(server)).toMatchObject({
      resourceType: "openbao_secret",
      resourceName: "app:my-app/host-1#token",
      details: `openbao-secrets.store createAppField by user alice through plugin runbooks at kv/${APPS_FOLDER}/my-app/host-1`,
      success: true,
    });
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).not.toContain(VALUE);
    expect(lastAppAudit(server)).toMatchObject({
      resourceName: "app:my-app/host-1#token",
      success: false,
      errorMessage:
        "the field token exists already at my-app/host-1, and is never replaced",
    });
    await server
      .service("alice", (store) =>
        store.createAppField(
          { plugin: "evil", key: "0".repeat(64) },
          "my-app",
          "host-1",
          "token",
          VALUE,
        ),
      )
      .catch(() => null);
    expect(lastAppAudit(server)).toMatchObject({
      details:
        "openbao-secrets.store createAppField by user alice through plugin evil (not verified)",
      success: false,
    });
    expect(auditText(server)).not.toContain(VALUE);
  });

  it("never puts the value in an error when OpenBao fails", async () => {
    server = await withApps();
    const caller = await bindAs(server, "runbooks");
    server.bao.failKv = 500;
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).toBe("Read metadata failed: HTTP 500");
    expect(auditText(server)).not.toContain(VALUE);
  });

  it("treats a saved setting that is not valid as a configuration error", async () => {
    server = await withApps({ allowed: "my-app/host-1\nnot valid" });
    const caller = await bindAs(server, "runbooks");
    const error = await server
      .service("alice", (store) =>
        store.createAppField(caller, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      "The allowed app paths setting is not valid",
    );
    await server.close();
    server = await withApps({ folder: "termix/apps" });
    const again = await bindAs(server, "runbooks");
    const second = await server
      .service("alice", (store) =>
        store.createAppField(again, "my-app", "host-1", "token", VALUE),
      )
      .catch((caught: Error) => caught);
    expect((second as Error).message).toBe(
      "The app secrets folder setting is not valid",
    );
    expect(appCalls(server)).toEqual([]);
  });
});
