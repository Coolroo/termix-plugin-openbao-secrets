import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSettings } from "../../src/backend/config";
import { WRAP_TOKEN_SPENT } from "../../src/backend/openbao";
import {
  ADMIN,
  FakeBao,
  MANAGE_SHARED,
  ROLE_ID,
  SECRET_ID,
  startServer,
  USE,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

describe("connect with a wrapped token", () => {
  it("unwraps once, keeps the secret ID sealed and logs in", async () => {
    server = await startServer();
    const token = server.bao.wrap();
    const made = await server.call("POST", "/admin/connect", {
      wrappingToken: token,
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      connected: true,
      by: "alice",
      login: { ok: true },
    });
    expect(JSON.stringify(made.body)).not.toContain(SECRET_ID);
    const rows = server.db.sqlite
      .prepare("SELECT name, value FROM p_openbao_secrets_state")
      .all() as Array<{ name: string; value: string }>;
    const stored = rows.find((row) => row.name === "secret-id");
    expect(stored?.value).toMatch(/^sealed:/);
    expect(stored?.value).not.toContain(SECRET_ID);

    // The same token a second time: OpenBao refuses it, the admin is told.
    const again = await server.call("POST", "/admin/connect", {
      wrappingToken: token,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe(WRAP_TOKEN_SPENT);
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "openbao_secrets_connect",
      success: false,
    });
  });

  it("is for admins only, and never for an API key", async () => {
    server = await startServer({ permissions: [USE, MANAGE_SHARED] });
    const refused = await server.call("POST", "/admin/connect", {
      wrappingToken: server.bao.wrap(),
    });
    expect(refused.status).toBe(403);
    await server.close();

    server = await startServer();
    const withKey = await server.call(
      "POST",
      "/admin/connect",
      { wrappingToken: server.bao.wrap() },
      { apiKey: true },
    );
    expect(withKey.status).toBe(403);
    expect(
      (await server.call("GET", "/admin/connection", undefined, { user: null }))
        .status,
    ).toBe(401);
  });

  it("asks for the settings first, and refuses junk", async () => {
    server = await startServer({ settings: {} });
    const early = await server.call("POST", "/admin/connect", {
      wrappingToken: server.bao.wrap(),
    });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/save the connection settings first/);
    const junk = await server.call("POST", "/admin/connect", {
      wrappingToken: "x",
    });
    expect(junk.status).toBe(400);
    expect(server.bao.calls).toHaveLength(0);
  });

  it("disconnects: revokes the token and deletes the secret ID", async () => {
    server = await startServer();
    await server.connect();
    const out = await server.call("POST", "/admin/disconnect");
    expect(out.status).toBe(200);
    expect(out.body.connected).toBe(false);
    expect(server.bao.calledPaths()).toContain("POST auth/token/revoke-self");
    expect(
      [...server.bao.tokens.values()].every((token) => token.revoked),
    ).toBe(true);
    const listed = await server.call("GET", "/secrets");
    expect(listed.status).toBe(409);
  });
});

describe("test connection", () => {
  it("logs in, writes, reads and deletes a probe, step by step", async () => {
    server = await startServer();
    await server.connect();
    const tested = await server.call("POST", "/admin/test");
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(
      tested.body.steps.map((step: { step: string }) => step.step),
    ).toEqual(["settings", "login", "write", "read", "delete"]);
    const probes = server.bao.calls.filter((call) =>
      call.path.startsWith("kv/data/termix/_probe/"),
    );
    expect(probes.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(server.bao.paths()).toEqual([]);
  });

  it("stops at the first step that fails", async () => {
    server = await startServer();
    await server.connect();
    server.bao.failKv = 403;
    const tested = await server.call("POST", "/admin/test");
    expect(tested.body.ok).toBe(false);
    expect(tested.body.steps.at(-1)).toMatchObject({
      step: "write",
      ok: false,
    });
    expect(tested.body.steps.at(-1).message).toMatch(/HTTP 403/);
  });

  it("says when it is not connected", async () => {
    server = await startServer();
    const tested = await server.call("POST", "/admin/test");
    expect(tested.body.steps).toEqual([
      { step: "settings", ok: true, message: "complete" },
      {
        step: "login",
        ok: false,
        message: "OpenBao is not connected: use Connect first",
      },
    ]);
  });
});

describe("settings", () => {
  it("refuses an http address and other bad values", async () => {
    expect(validateSettings({ address: "http://bao.internal:8200" })).toEqual({
      address: "The address must start with https://",
    });
    expect(
      validateSettings({
        address: "https://user:pw@bao.internal",
        caPem: "nope",
        kvMount: "../x",
        roleId: "has space",
      }),
    ).toEqual({
      address: "The address must not contain a user name or password",
      caPem: "Paste one or more PEM certificates (-----BEGIN CERTIFICATE-----)",
      kvMount:
        "Use one to four parts of letters, digits, '.', '_' and '-', joined by '/'",
      roleId: "The role ID has characters it cannot have",
    });
    server = await startServer();
    expect(
      await server.mock.validateSettings("admin", {
        address: "http://bao.internal",
      }),
    ).toEqual({ address: "The address must start with https://" });
  });

  it("never calls an http address, even one saved behind the check", async () => {
    server = await startServer({
      settings: { address: "http://bao.internal:8200", roleId: ROLE_ID },
    });
    const status = await server.call("GET", "/admin/connection");
    expect(status.body).toMatchObject({ configured: false });
    expect(status.body.problem).toMatch(/https/);
    const made = await server.call("POST", "/admin/connect", {
      wrappingToken: server.bao.wrap(),
    });
    expect(made.status).toBe(409);
    expect(server.bao.calls).toHaveLength(0);
  });
});

describe("every request to OpenBao", () => {
  it("allows exactly the configured host, with its CA, no redirects and a timeout", async () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    server = await startServer({
      settings: {
        address: "https://Bao.Internal:8200/",
        roleId: ROLE_ID,
        caPem: ca,
      },
    });
    await server.connect();
    await server.call("POST", "/admin/test");
    expect(server.bao.calls.length).toBeGreaterThan(4);
    for (const call of server.bao.calls) {
      expect(call.init?.allowPrivateHosts).toEqual(["bao.internal"]);
      expect(call.init?.tls).toEqual({ ca });
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.timeoutMs).toBe(10_000);
    }
    expect(server.mock.fetches[0].url).toMatch(
      /^https:\/\/bao\.internal:8200\/v1\//i,
    );
  });

  it("uses the default trust store when no CA is set, and an IP host as given", async () => {
    server = await startServer({
      settings: { address: "https://[fd00::5]:8200", roleId: ROLE_ID },
    });
    await server.connect();
    for (const call of server.bao.calls) {
      expect(call.init?.allowPrivateHosts).toEqual(["fd00::5"]);
      expect(call.init?.tls).toBeUndefined();
    }
  });
});

describe("login and renewal", () => {
  it("renews at two thirds of the lease, and logs in again when renewal fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    const bao = new FakeBao();
    bao.leaseSeconds = 60;
    server = await startServer({ bao });
    await server.connect();
    const logins = () =>
      bao.calls.filter((call) => call.path === "auth/approle/login").length;
    const renewals = () =>
      bao.calls.filter((call) => call.path === "auth/token/renew-self").length;
    expect(logins()).toBe(1);

    await server.call("GET", "/secrets");
    expect(logins()).toBe(1);
    expect(renewals()).toBe(0);

    vi.setSystemTime(new Date("2026-11-09T10:00:45Z"));
    await server.call("GET", "/secrets");
    expect(renewals()).toBe(1);
    expect(logins()).toBe(1);

    bao.refuseRenew = true;
    vi.setSystemTime(new Date("2026-11-09T10:01:30Z"));
    const listed = await server.call("GET", "/secrets");
    expect(listed.status).toBe(200);
    expect(renewals()).toBe(2);
    expect(logins()).toBe(2);
  });

  it("logs in again once when OpenBao revoked the token behind its back", async () => {
    server = await startServer();
    await server.connect();
    for (const token of server.bao.tokens.values()) token.revoked = true;
    const listed = await server.call("GET", "/secrets");
    expect(listed.status).toBe(200);
    expect(
      server.bao.calls.filter((call) => call.path === "auth/approle/login"),
    ).toHaveLength(2);
  });

  it("revokes its token when the plugin stops", async () => {
    server = await startServer();
    await server.connect();
    await server.call("GET", "/secrets");
    for (const dispose of server.mock.disposals) await dispose();
    expect(server.bao.calledPaths().at(-1)).toBe("POST auth/token/revoke-self");
    expect(
      [...server.bao.tokens.values()].every((token) => token.revoked),
    ).toBe(true);
  });

  it("answers 502 without OpenBao's own words when OpenBao fails", async () => {
    server = await startServer();
    await server.connect();
    server.bao.failKv = 500;
    const listed = await server.call("GET", "/secrets");
    expect(listed.status).toBe(502);
    expect(listed.body.error).toBe("List failed: HTTP 500");
  });
});

describe("admin status", () => {
  it("names who connected and when, and nothing secret", async () => {
    server = await startServer({ permissions: [USE, ADMIN] });
    await server.connect();
    const status = await server.call("GET", "/admin/connection");
    expect(status.body).toMatchObject({
      configured: true,
      connected: true,
      by: "alice",
      problem: null,
    });
    expect(typeof status.body.since).toBe("string");
    expect(JSON.stringify(status.body)).not.toContain(SECRET_ID);
  });
});
