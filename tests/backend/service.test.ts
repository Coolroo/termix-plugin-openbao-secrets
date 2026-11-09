import { afterEach, describe, expect, it, vi } from "vitest";
import type { Area } from "../../src/backend/service";
import {
  auditText,
  MANAGE_SHARED,
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

const VALUE = "s3cret-value";

async function connected(permissions?: string[]): Promise<TestServer> {
  return startServer({
    connected: true,
    ...(permissions ? { permissions } : {}),
  });
}

/**
 * A consumer plugin's side of the handshake: a receiver under its own id,
 * taking the key only while its own bind is in flight.
 */
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

describe("openbao-secrets.store", () => {
  it("is provided under a name that starts with the plugin id", async () => {
    server = await startServer();
    expect(server.mock.services.has("openbao-secrets.store")).toBe(true);
    const status = await server.service("alice", (store) => store.status());
    expect(status).toEqual({ connected: false, backend: "openbao-kv2" });
  });

  it("puts, gets, lists, removes and removes by prefix in each area", async () => {
    server = await connected();
    const plugin = await bindAs(server, "runbooks");
    for (const area of ["user", "shared", plugin] as Area[]) {
      await server.service("alice", async (store) => {
        await store.put(area, "rb-1/db", VALUE, { note: "step 2" });
        await store.put(area, "rb-1/api", "other");
        await store.put(area, "rb-2/db", "third");
        expect(await store.get(area, "rb-1/db")).toBe(VALUE);
        expect(await store.get(area, "missing")).toBeNull();
        const listed = await store.list(area, "rb-1");
        expect(listed.map((entry) => entry.name).sort()).toEqual([
          "rb-1/api",
          "rb-1/db",
        ]);
        expect(listed.find((entry) => entry.name === "rb-1/db")).toMatchObject({
          createdBy: "alice",
          note: "step 2",
          expiresAt: null,
        });
        expect(JSON.stringify(listed)).not.toContain(VALUE);
        expect(await store.remove(area, "rb-1/api")).toBe(true);
        expect(await store.remove(area, "rb-1/api")).toBe(false);
        expect(await store.removePrefix(area, "rb-1/")).toBe(1);
        expect((await store.list(area)).map((entry) => entry.name)).toEqual([
          "rb-2/db",
        ]);
      });
    }
    expect(server.bao.paths()).toEqual([
      "termix/plugins/runbooks/rb-2/db",
      "termix/shared/rb-2/db",
      "termix/users/alice/rb-2/db",
    ]);
  });

  it("audits every call without the value", async () => {
    server = await connected();
    await server.service("alice", async (store) => {
      await store.put("user", "a", VALUE);
      await store.get("user", "a");
      await store.get("user", "../nope").catch(() => null);
    });
    const lines = server.mock.audits.filter((line) =>
      line.action.startsWith("openbao_secrets_service_"),
    );
    expect(lines.map((line) => [line.action, line.success])).toEqual([
      ["openbao_secrets_service_put", true],
      ["openbao_secrets_service_get", true],
      ["openbao_secrets_service_get", false],
    ]);
    expect(lines[0].resourceName).toBe("user/a");
    expect(auditText(server)).not.toContain(VALUE);
  });

  it("never puts the value in an error", async () => {
    server = await connected();
    server.bao.failKv = 500;
    const error = await server
      .service("alice", (store) => store.put("user", "a", VALUE))
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(VALUE);
  });
});

describe("area rules", () => {
  it("keeps the user area per acting user", async () => {
    server = await connected();
    await server.service("alice", (store) => store.put("user", "x", VALUE));
    expect(
      await server.service("bob", (store) => store.get("user", "x")),
    ).toBeNull();
    expect(server.bao.paths()).toEqual(["termix/users/alice/x"]);
  });

  it("needs use to read and manage-shared to write shared secrets", async () => {
    server = await connected([USE]);
    await expect(
      server.service("alice", (store) => store.put("shared", "x", VALUE)),
    ).rejects.toThrow(/Manage shared secrets/);
    await expect(
      server.service("alice", (store) => store.removePrefix("shared", "")),
    ).rejects.toThrow(/Manage shared secrets/);
    expect(
      await server.service("alice", (store) => store.list("shared")),
    ).toEqual([]);
    await server.close();

    server = await connected([MANAGE_SHARED]);
    for (const area of ["user", "shared"] as Area[]) {
      await expect(
        server.service("alice", (store) => store.get(area, "x")),
      ).rejects.toThrow(/Use secrets/);
    }
  });

  it("needs use for a plugin's area too", async () => {
    server = await connected();
    const area = await bindAs(server, "runbooks");
    await server.close();
    server = await connected([MANAGE_SHARED]);
    await expect(
      server.service("alice", (store) => store.get(area, "x")),
    ).rejects.toThrow(/Use secrets/);
  });

  it("refuses an expiry more than 30 days ahead", async () => {
    server = await connected();
    const day = 24 * 60 * 60 * 1000;
    const ok = new Date(Date.now() + 7 * day).toISOString();
    await server.service("alice", (store) =>
      store.put("user", "week", VALUE, { expiresAt: ok }),
    );
    const far = new Date(Date.now() + 31 * day).toISOString();
    await expect(
      server.service("alice", (store) =>
        store.put("user", "month", VALUE, { expiresAt: far }),
      ),
    ).rejects.toThrow(
      "expiresAt is more than 30 days ahead: the limit is 30 days",
    );
    await expect(
      server.service("alice", (store) =>
        store.put("user", "past", VALUE, {
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).rejects.toThrow(/in the past/);
    expect(server.bao.paths()).toEqual(["termix/users/alice/week"]);
  });
});

describe("a plugin's own area", () => {
  it("hands the area key only to the plugin's own receiver", async () => {
    server = await connected();
    const area = await bindAs(server, "runbooks");
    expect(area.key).toMatch(/^[0-9a-f]{64}$/);
    // The same key on every bind: an HMAC under a sealed random key.
    const again = await bindAs(server, "runbooks");
    expect(again.key).toBe(area.key);
    // Another plugin's area has another key.
    const other = await bindAs(server, "notes");
    expect(other.key).not.toBe(area.key);
  });

  it("refuses a bind without a receiver, and a plugin id it cannot be", async () => {
    server = await connected();
    await expect(
      server.service("alice", (store) => store.bindPlugin("nobody")),
    ).rejects.toThrow(/no nobody.secretsStoreKey receiver/);
    await expect(
      server.service("alice", (store) => store.bindPlugin("../x")),
    ).rejects.toThrow(/needs a plugin id/);
  });

  it("isolates areas: a forged or borrowed key reads nothing", async () => {
    server = await connected();
    const runbooks = await bindAs(server, "runbooks");
    await server.service("alice", (store) =>
      store.put(runbooks, "token", VALUE),
    );
    const notes = await bindAs(server, "notes");
    const notesKey = notes.key;
    // "notes" claims to be runbooks with its own key.
    await expect(
      server.service("alice", (store) =>
        store.get({ plugin: "runbooks", key: notesKey }, "token"),
      ),
    ).rejects.toThrow(/not runbooks's/);
    await expect(
      server.service("alice", (store) =>
        store.get({ plugin: "runbooks", key: "0".repeat(64) }, "token"),
      ),
    ).rejects.toThrow(/not runbooks's/);
    await expect(
      server.service("alice", (store) =>
        store.get({ plugin: "runbooks" } as never, "token"),
      ),
    ).rejects.toThrow(/call bindPlugin/);
    await expect(
      server.service("alice", (store) => store.get("plugin" as never, "token")),
    ).rejects.toThrow(/call bindPlugin/);
    // Its own area holds nothing of runbooks'.
    expect(
      await server.service("alice", (store) => store.get(notes, "token")),
    ).toBeNull();
    expect(
      await server.service("bob", (store) => store.get(runbooks, "token")),
    ).toBe(VALUE);
  });

  it("cannot be bound for another plugin: its key goes to the owner, not the caller", async () => {
    server = await connected();
    const received: string[] = [];
    server.provideAsConsumer("runbooks.secretsStoreKey", (key: string) => {
      received.push(key);
    });
    // Any caller can ask for runbooks' bind; the answer is empty.
    const answer = await server.service("alice", (store) =>
      store.bindPlugin("runbooks"),
    );
    expect(answer).toBeUndefined();
    expect(received).toHaveLength(1);
    // And core lets a plugin provide registry keys under its own id only.
    expect(() =>
      server!.mock.ctx.registry.provide("runbooks.secretsStoreKey", () => {}),
    ).toThrow(/may only use registry keys under "openbao-secrets."/);
  });
});

describe("expiry", () => {
  it("reads an expired secret as gone and the sweep deletes them in every area", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    server = await connected();
    const plugin = await bindAs(server, "runbooks");
    const soon = new Date("2026-11-10T10:00:00Z").toISOString();
    const later = new Date("2026-11-20T10:00:00Z").toISOString();
    await server.service("alice", async (store) => {
      await store.put("user", "u-soon", VALUE, { expiresAt: soon });
      await store.put("shared", "s-soon", VALUE, { expiresAt: soon });
      await store.put(plugin, "rb-1/p-soon", VALUE, { expiresAt: soon });
      await store.put(plugin, "rb-1/p-later", VALUE, { expiresAt: later });
      await store.put("user", "forever", VALUE);
    });
    await server.service("bob", (store) =>
      store.put("user", "b-soon", VALUE, { expiresAt: soon }),
    );

    vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
    expect(
      await server.service("alice", (store) => store.list(plugin, "rb-1")),
    ).toHaveLength(1);
    expect(
      await server.service("alice", (store) => store.get("user", "u-soon")),
    ).toBeNull();
    expect(server.bao.paths()).not.toContain("termix/users/alice/u-soon");

    await server.mock.runScheduled();
    expect(server.bao.paths()).toEqual([
      "termix/plugins/runbooks/rb-1/p-later",
      "termix/users/alice/forever",
    ]);
    const job = server.mock.scheduled.find((entry) => entry.kind === "every");
    expect(job?.ms).toBe(60 * 60 * 1000);
  });

  it("the sweep stays quiet while OpenBao is not connected", async () => {
    server = await startServer();
    await server.mock.runScheduled();
    expect(server.bao.calls).toHaveLength(0);
  });
});
