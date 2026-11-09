import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { validateSettings } from "./config.js";
import { createConnection } from "./connection.js";
import { createOpenBao } from "./openbao.js";
import { createPluginAreas } from "./plugin-areas.js";
import { registerRoutes } from "./routes.js";
import { createSecrets } from "./secrets.js";
import { createSecretsStore, SERVICE } from "./service.js";
import { createStateStore } from "./state.js";

/** How often secrets past their expiresAt are deleted. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Settings that change where or how the plugin logs in. */
const CONNECTION_SETTINGS = [
  "address",
  "caPem",
  "kvMount",
  "basePath",
  "roleId",
] as const;

export async function activate(ctx: PluginContext) {
  const state = await createStateStore(ctx.db, ctx.secrets);
  const bao = createOpenBao({ ctx, secretId: () => state.get("secret-id") });
  const secrets = createSecrets(bao);
  const areas = createPluginAreas(ctx, state);
  const connection = createConnection(bao, state);

  ctx.settings.onValidate("admin", (values) => validateSettings(values));
  // A new address, CA or role means the token in memory may be for the old
  // one: forget it, and log in again on the next call.
  for (const key of CONNECTION_SETTINGS) {
    ctx.settings.onChange(key, () => bao.reset());
  }

  ctx.services.provide(
    SERVICE,
    createSecretsStore(ctx, secrets, areas, connection),
  );

  registerRoutes(ctx.http.router<Router>(), ctx, secrets, connection);

  // Deletes secrets whose expiresAt has passed, in every area. Quiet while
  // OpenBao is not connected; a failure is logged and tried again next hour.
  ctx.schedule.every(
    SWEEP_INTERVAL_MS,
    async () => {
      const status = await connection.status();
      if (!status.configured || !status.connected) return;
      try {
        const removed = await secrets.sweep();
        if (removed.length > 0) {
          ctx.log.info(`expiry sweep deleted ${removed.length} secret(s)`);
        }
      } catch (error) {
        ctx.log.warn(
          `expiry sweep failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    },
    { runNow: true },
  );

  // Revoke the token at OpenBao when the plugin stops; it would run out on
  // its own, but there is no reason to leave it valid.
  ctx.disposables.add(() => bao.revoke());
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core, the token
  // revocation above included.
}
