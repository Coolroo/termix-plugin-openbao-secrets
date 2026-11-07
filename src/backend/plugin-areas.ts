/**
 * Proof that a service call for a plugin's own area comes from that plugin.
 *
 * Core does not tell a service provider which plugin is calling: the
 * service registry (src/backend/plugins/service-registry.ts in Termix
 * 26.11.0) passes only the arguments and runs the call as the acting user.
 * A plugin id given as an argument could be any plugin's, so it is never
 * trusted on its own.
 *
 * What core does guarantee is that ctx.registry.provide only takes keys
 * under the caller's own id ("<pluginId>.something"). So the consumer
 * provides a receiver function under "<its id>.secretsStoreKey", and
 * bindPlugin("<id>") hands that plugin's area key to that receiver, and to
 * nothing else. The key is an HMAC of the plugin id under a random key that
 * never leaves this plugin, so it stays the same across restarts, and every
 * call for the area must carry it. Another plugin can ask for a bind, but
 * the key goes to the real owner, never back to the one that asked.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { StateStore } from "./state.js";

/** The registry key suffix a consumer provides its receiver under. */
export const RECEIVER_SUFFIX = "secretsStoreKey";

/** Plugin ids as the manifest allows them. */
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,39}$/;
const KEY = /^[0-9a-f]{64}$/;

export class AreaError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = "AreaError";
    this.status = status;
  }
}

export interface PluginArea {
  plugin: string;
  key: string;
}

export type PluginAreas = ReturnType<typeof createPluginAreas>;

export function createPluginAreas(ctx: PluginContext, state: StateStore) {
  let master: Promise<string> | null = null;

  /** The random key every area key comes from, made on first use. */
  function masterKey(): Promise<string> {
    if (!master) {
      master = (async () => {
        const existing = await state.get("area-key");
        if (existing) return existing;
        const made = randomBytes(32).toString("hex");
        await state.set("area-key", made, "system");
        return made;
      })().catch((error) => {
        master = null;
        throw error;
      });
    }
    return master;
  }

  async function keyFor(pluginId: string): Promise<string> {
    return createHmac("sha256", await masterKey())
      .update(`plugin-area:${pluginId}`)
      .digest("hex");
  }

  return {
    /**
     * Hands `pluginId` its area key through the receiver it provided in
     * ctx.registry. Only that plugin can have provided it.
     */
    async bind(pluginId: unknown): Promise<void> {
      if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId)) {
        throw new AreaError("bindPlugin needs a plugin id", 400);
      }
      const receiver = ctx.registry.consume<unknown>(
        `${pluginId}.${RECEIVER_SUFFIX}`,
      );
      if (typeof receiver !== "function") {
        throw new AreaError(
          `plugin ${pluginId} has no ${pluginId}.${RECEIVER_SUFFIX} receiver in ctx.registry`,
          409,
        );
      }
      const key = await keyFor(pluginId);
      try {
        await (receiver as (key: string) => unknown)(key);
      } catch {
        throw new AreaError(`plugin ${pluginId} refused its area key`, 409);
      }
    },

    /** The plugin id the area belongs to, once its key checks out. */
    async verify(area: unknown): Promise<string> {
      const value = area as Partial<PluginArea> | null;
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.plugin !== "string" ||
        !PLUGIN_ID.test(value.plugin) ||
        typeof value.key !== "string" ||
        !KEY.test(value.key)
      ) {
        throw new AreaError(
          'a plugin area is { plugin, key }: call bindPlugin(<your id>) for the key',
          400,
        );
      }
      const expected = Buffer.from(await keyFor(value.plugin), "hex");
      const given = Buffer.from(value.key, "hex");
      if (!timingSafeEqual(expected, given)) {
        throw new AreaError(
          `the area key is not ${value.plugin}'s: call bindPlugin again`,
        );
      }
      return value.plugin;
    },
  };
}
