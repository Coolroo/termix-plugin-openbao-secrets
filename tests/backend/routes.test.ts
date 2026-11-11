import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN,
  auditText,
  MANAGE_SHARED,
  startServer,
  USE,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const VALUE = "hunter2-very-secret";

async function connected(permissions?: string[]): Promise<TestServer> {
  return startServer({
    connected: true,
    ...(permissions ? { permissions } : {}),
  });
}

describe("the Secrets tab's list", () => {
  it("has names and metadata only, never a value", async () => {
    server = await connected();
    const added = await server.call("POST", "/secrets", {
      section: "user",
      name: "db/prod/root",
      value: VALUE,
      note: "rotated monthly",
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      name: "db/prod/root",
      createdBy: "alice",
      note: "rotated monthly",
    });
    await server.call("POST", "/secrets", {
      section: "shared",
      name: "wifi",
      value: "line one\nline two",
    });
    const listed = await server.call("GET", "/secrets");
    expect(listed.status).toBe(200);
    expect(
      listed.body.user.map((entry: { name: string }) => entry.name),
    ).toEqual(["db/prod/root"]);
    expect(
      listed.body.shared.map((entry: { name: string }) => entry.name),
    ).toEqual(["wifi"]);
    const text = JSON.stringify(listed.body) + JSON.stringify(added.body);
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain("line one");
    expect(Object.keys(listed.body.user[0]).sort()).toEqual([
      "createdAt",
      "createdBy",
      "expiresAt",
      "name",
      "note",
      "updatedAt",
    ]);
    // Stored where the layout says, as the KV field "value".
    expect(server.bao.paths()).toEqual([
      "termix/shared/wifi",
      "termix/users/alice/db/prod/root",
    ]);
    expect(server.bao.kv.get("termix/users/alice/db/prod/root")).toMatchObject({
      value: VALUE,
      custom: { createdBy: "alice", note: "rotated monthly" },
    });
  });

  it("keeps each person's own secrets apart", async () => {
    server = await connected();
    await server.call("POST", "/secrets", {
      section: "user",
      name: "mine",
      value: VALUE,
    });
    const bob = await server.call("GET", "/secrets", undefined, {
      user: "bob",
    });
    expect(bob.body.user).toEqual([]);
    const bobType = await server.call(
      "POST",
      "/type",
      { section: "user", name: "mine" },
      { user: "bob" },
    );
    expect(bobType.status).toBe(404);
  });

  it("says when OpenBao is not connected", async () => {
    server = await startServer();
    const status = await server.call("GET", "/status");
    expect(status.body).toMatchObject({
      configured: true,
      connected: false,
      canManageShared: true,
      isAdmin: true,
    });
    const listed = await server.call("GET", "/secrets");
    expect(listed.status).toBe(409);
    expect(listed.body.error).toMatch(/ask an admin to connect it/);
  });
});

describe("add, replace and delete", () => {
  it("refuses a second add, replaces keeping the note, deletes every version", async () => {
    server = await connected();
    const body = { section: "user", name: "api/key", value: "v1", note: "n" };
    expect((await server.call("POST", "/secrets", body)).status).toBe(201);
    const again = await server.call("POST", "/secrets", body);
    expect(again.status).toBe(409);
    const replaced = await server.call("PUT", "/secrets", {
      section: "user",
      name: "api/key",
      value: "v2",
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.note).toBe("n");
    const entry = server.bao.kv.get("termix/users/alice/api/key");
    expect(entry).toMatchObject({ value: "v2", versions: 2 });
    const missing = await server.call("PUT", "/secrets", {
      section: "user",
      name: "nope",
      value: "x",
    });
    expect(missing.status).toBe(404);
    const removed = await server.call(
      "DELETE",
      "/secrets?section=user&name=api%2Fkey",
    );
    expect(removed.status).toBe(200);
    expect(server.bao.paths()).toEqual([]);
    expect(
      server.bao
        .calledPaths()
        .includes("DELETE kv/metadata/termix/users/alice/api/key"),
    ).toBe(true);
    expect(
      (await server.call("DELETE", "/secrets?section=user&name=api%2Fkey"))
        .status,
    ).toBe(404);
    const actions = server.mock.audits.map((line) => line.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "openbao_secrets_add",
        "openbao_secrets_replace",
        "openbao_secrets_delete",
      ]),
    );
    expect(auditText(server)).not.toContain("v2");
  });

  it("takes a new value back when OpenBao refuses its metadata", async () => {
    server = await connected();
    server.bao.failMetadataWrite = 403;
    const body = { section: "user", name: "api/key", value: VALUE };
    const refused = await server.call("POST", "/secrets", body);
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe(
      "Write metadata: OpenBao refused it (HTTP 403)",
    );
    expect(server.bao.paths()).toEqual([]);
    server.bao.failMetadataWrite = null;
    expect((await server.call("POST", "/secrets", body)).status).toBe(201);
    expect(server.bao.kv.get("termix/users/alice/api/key")?.custom).toEqual({
      createdBy: "alice",
    });
  });

  it("checks names, values and notes", async () => {
    server = await connected();
    for (const bad of [
      { section: "user", name: "../x", value: "v" },
      { section: "user", name: "a/b/c/d/e", value: "v" },
      { section: "user", name: "ok", value: "" },
      { section: "user", name: "ok", value: "v", note: "n".repeat(201) },
      { section: "elsewhere", name: "ok", value: "v" },
    ]) {
      expect((await server.call("POST", "/secrets", bad)).status).toBe(400);
    }
    expect(server.bao.paths()).toEqual([]);
  });

  it("needs Manage shared secrets to change a shared secret", async () => {
    server = await connected([USE]);
    const added = await server.call("POST", "/secrets", {
      section: "shared",
      name: "team",
      value: VALUE,
    });
    expect(added.status).toBe(403);
    expect(added.body.error).toMatch(/Manage shared secrets/);
    expect(
      (await server.call("DELETE", "/secrets?section=shared&name=team")).status,
    ).toBe(403);
    // Their own secrets still work.
    expect(
      (
        await server.call("POST", "/secrets", {
          section: "user",
          name: "mine",
          value: VALUE,
        })
      ).status,
    ).toBe(201);
    expect((await server.call("GET", "/status")).body).toMatchObject({
      canManageShared: false,
      isAdmin: false,
    });
  });

  it("needs Use secrets for everything", async () => {
    server = await startServer({ permissions: [MANAGE_SHARED, ADMIN] });
    await server.connect();
    for (const [method, path] of [
      ["GET", "/status"],
      ["GET", "/secrets"],
      ["POST", "/secrets"],
      ["PUT", "/secrets"],
      ["DELETE", "/secrets?section=user&name=x"],
      ["POST", "/type"],
    ]) {
      const answer = await server.call(method, path, {
        section: "user",
        name: "x",
        value: "v",
      });
      expect(answer.status, `${method} ${path}`).toBe(403);
    }
  });

  it("needs a signed-in person", async () => {
    server = await connected();
    expect(
      (await server.call("GET", "/secrets", undefined, { user: null })).status,
    ).toBe(401);
  });
});

describe("typing into a terminal", () => {
  it("answers the value only to the caller, uncached, and audits it", async () => {
    server = await connected();
    await server.call("POST", "/secrets", {
      section: "shared",
      name: "root",
      value: VALUE,
    });
    const typed = await server.call("POST", "/type", {
      section: "shared",
      name: "root",
      sessionId: "tab-7",
      hostId: 3,
    });
    expect(typed.status).toBe(200);
    expect(typed.body).toEqual({ value: VALUE });
    expect(typed.headers["cache-control"]).toBe("no-store");
    const line = server.mock.audits.find(
      (entry) => entry.action === "openbao_secrets_type",
    );
    expect(line).toMatchObject({
      success: true,
      resourceName: "shared/root",
      details: "typed a secret into a terminal (session tab-7, host 3)",
    });
    expect(auditText(server)).not.toContain(VALUE);
    expect(server.mock.audits.length).toBeGreaterThan(0);
  });

  it("is refused for a core API key", async () => {
    server = await connected();
    await server.call("POST", "/secrets", {
      section: "user",
      name: "root",
      value: VALUE,
    });
    const typed = await server.call(
      "POST",
      "/type",
      { section: "user", name: "root" },
      { apiKey: true },
    );
    expect(typed.status).toBe(403);
    expect(JSON.stringify(typed.body)).not.toContain(VALUE);
  });

  it("audits a miss, and cleans the session id it records", async () => {
    server = await connected();
    const typed = await server.call("POST", "/type", {
      section: "user",
      name: "nothing",
      sessionId: "tab<script>",
    });
    expect(typed.status).toBe(404);
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "openbao_secrets_type",
      success: false,
      details:
        "typed a secret into a terminal (session tabscript, host unknown)",
    });
  });

  it("puts a value in a variable, and audits the mode and the name, never the value", async () => {
    server = await connected();
    await server.call("POST", "/secrets", {
      section: "user",
      name: "runbook-test",
      value: VALUE,
    });
    const typed = await server.call("POST", "/type", {
      section: "user",
      name: "runbook-test",
      sessionId: "tab-7",
      hostId: 3,
      mode: "variable",
      variable: "RUNBOOK_TEST",
    });
    expect(typed.status).toBe(200);
    expect(typed.body).toEqual({ value: VALUE });
    expect(typed.headers["cache-control"]).toBe("no-store");
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "openbao_secrets_type",
      success: true,
      resourceName: "user/runbook-test",
      details:
        "put a secret in a shell variable (mode variable, variable RUNBOOK_TEST, session tab-7, host 3)",
    });
    expect(auditText(server)).not.toContain(VALUE);
  });

  it("keeps the cursor mode's line when the mode is cursor", async () => {
    server = await connected();
    await server.call("POST", "/secrets", {
      section: "user",
      name: "root",
      value: VALUE,
    });
    const typed = await server.call("POST", "/type", {
      section: "user",
      name: "root",
      mode: "cursor",
    });
    expect(typed.status).toBe(200);
    expect(server.mock.audits.at(-1)?.details).toBe(
      "typed a secret into a terminal (session unknown, host unknown)",
    );
  });

  it("refuses a bad mode or variable name before it reads anything", async () => {
    server = await connected();
    await server.call("POST", "/secrets", {
      section: "user",
      name: "root",
      value: VALUE,
    });
    const before = server.mock.audits.length;
    for (const input of [
      { mode: "paste" },
      { mode: "variable" },
      { mode: "variable", variable: "1ROOT" },
      { mode: "variable", variable: "ROOT;id" },
      { mode: "variable", variable: "PATH" },
    ]) {
      const typed = await server.call("POST", "/type", {
        section: "user",
        name: "root",
        ...input,
      });
      expect(typed.status).toBe(400);
      expect(JSON.stringify(typed.body)).not.toContain(VALUE);
    }
    expect(server.mock.audits.length).toBe(before);
  });

  it("refuses a value one read line cannot hold, without the value", async () => {
    server = await connected();
    const multiline = "line one\nrm -rf ~";
    await server.call("POST", "/secrets", {
      section: "user",
      name: "key",
      value: multiline,
    });
    const typed = await server.call("POST", "/type", {
      section: "user",
      name: "key",
      mode: "variable",
      variable: "KEY",
    });
    expect(typed.status).toBe(422);
    expect(JSON.stringify(typed.body)).not.toContain("rm -rf");
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "openbao_secrets_type",
      success: false,
    });
    expect(auditText(server)).not.toContain("rm -rf");
    // Typed at the cursor, the same secret is still given.
    const atCursor = await server.call("POST", "/type", {
      section: "user",
      name: "key",
    });
    expect(atCursor.status).toBe(200);
  });
});
