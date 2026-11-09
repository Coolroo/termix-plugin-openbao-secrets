/**
 * The service openbao-secrets.store 1.0.0, for other plugins
 * (docs/service.md).
 *
 * Core checks the "openbao-secrets.use" permission for the acting user
 * before every call and runs the call as that user, so the user comes from
 * ctx.currentActor() and never from an argument. Shared writes also need
 * manage-shared. A plugin's own area needs that plugin's area key (see
 * plugin-areas.ts), because core does not say which plugin is calling.
 *
 * Values travel only in arguments and results. Errors and audit lines name
 * the area and the secret, never the value.
 */

import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connection } from "./connection.js";
import { AreaError, type PluginAreas } from "./plugin-areas.js";
import {
  checkName,
  checkPrefix,
  InputError,
  type AreaRef,
  type PutOptions,
  type Secrets,
  type SecretEntry,
} from "./secrets.js";

export const SERVICE = "openbao-secrets.store";

export type Area = "user" | "shared" | { plugin: string; key: string };

export interface SecretsStore {
  status(): Promise<{ connected: boolean; backend: string }>;
  bindPlugin(pluginId: string): Promise<void>;
  put(
    area: Area,
    name: string,
    value: string,
    options?: PutOptions,
  ): Promise<void>;
  get(area: Area, name: string): Promise<string | null>;
  remove(area: Area, name: string): Promise<boolean>;
  list(area: Area, prefix?: string): Promise<ServiceEntry[]>;
  removePrefix(area: Area, prefix: string): Promise<number>;
}

export type ServiceEntry = Pick<
  SecretEntry,
  "name" | "createdAt" | "updatedAt" | "createdBy" | "expiresAt" | "note"
>;

export function createSecretsStore(
  ctx: PluginContext,
  secrets: Secrets,
  areas: PluginAreas,
  connection: Connection,
): SecretsStore {
  function actor(): string {
    const userId = ctx.currentActor();
    if (!userId)
      throw new AreaError("openbao-secrets.store needs an acting user", 401);
    return userId;
  }

  async function need(permission: "use" | "manage-shared"): Promise<void> {
    if (!(await ctx.rbac.has(permission))) {
      throw new AreaError(
        permission === "use"
          ? "you need the Use secrets permission"
          : "you need the Manage shared secrets permission",
      );
    }
  }

  /** The area as a path root, with its permission checked. */
  async function resolve(
    area: unknown,
    write: boolean,
  ): Promise<{ ref: AreaRef; label: string }> {
    const userId = actor();
    if (area === "user") {
      await need("use");
      return { ref: { kind: "user", userId }, label: "user" };
    }
    if (area === "shared") {
      await need("use");
      if (write) await need("manage-shared");
      return { ref: { kind: "shared" }, label: "shared" };
    }
    if (area === "plugin") {
      throw new AreaError(
        "the plugin area is { plugin: <your id>, key }: call bindPlugin(<your id>) first (docs/service.md)",
        400,
      );
    }
    if (area && typeof area === "object") {
      // Core already checks "use" before every service call; checked here
      // too so the rule holds whoever calls this object.
      await need("use");
      const pluginId = await areas.verify(area);
      return { ref: { kind: "plugin", pluginId }, label: `plugin:${pluginId}` };
    }
    throw new InputError('area is "user", "shared" or { plugin, key }');
  }

  /** Runs one call and writes its audit line, success or not. */
  async function audited<T>(
    method: string,
    target: () => string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn();
      await ctx.audit.record({
        action: `openbao_secrets_service_${method}`,
        resourceType: "openbao_secret",
        resourceName: target().slice(0, 250),
        details: `openbao-secrets.store ${method}`,
        success: true,
      });
      return result;
    } catch (error) {
      await ctx.audit.record({
        action: `openbao_secrets_service_${method}`,
        resourceType: "openbao_secret",
        resourceName: target().slice(0, 250),
        details: `openbao-secrets.store ${method}`,
        success: false,
        errorMessage: error instanceof Error ? error.message : "failed",
      });
      throw error;
    }
  }

  const label = (area: unknown) =>
    area === "user" || area === "shared"
      ? area
      : area && typeof area === "object" && "plugin" in area
        ? `plugin:${String((area as { plugin: unknown }).plugin).slice(0, 40)}`
        : "unknown";
  const target = (area: unknown, name: unknown) =>
    `${label(area)}/${typeof name === "string" ? name.slice(0, 200) : ""}`;

  return {
    async status() {
      return {
        connected: (await connection.status()).connected,
        backend: "openbao-kv2",
      };
    },

    async bindPlugin(pluginId) {
      return audited(
        "bind",
        () => `plugin:${String(pluginId).slice(0, 40)}`,
        () => areas.bind(pluginId),
      );
    },

    async put(area, name, value, options) {
      return audited(
        "put",
        () => target(area, name),
        async () => {
          const { ref } = await resolve(area, true);
          await secrets.put(ref, checkName(name), value, options, actor());
        },
      );
    },

    async get(area, name) {
      return audited(
        "get",
        () => target(area, name),
        async () => {
          const { ref } = await resolve(area, false);
          return secrets.get(ref, checkName(name));
        },
      );
    },

    async remove(area, name) {
      return audited(
        "remove",
        () => target(area, name),
        async () => {
          const { ref } = await resolve(area, true);
          return secrets.remove(ref, checkName(name));
        },
      );
    },

    async list(area, prefix) {
      return audited(
        "list",
        () => target(area, prefix ?? ""),
        async () => {
          const { ref } = await resolve(area, false);
          const entries = await secrets.list(ref, checkPrefix(prefix));
          return entries.map(
            ({ name, createdAt, updatedAt, createdBy, expiresAt, note }) => ({
              name,
              createdAt,
              updatedAt,
              createdBy,
              expiresAt,
              note,
            }),
          );
        },
      );
    },

    async removePrefix(area, prefix) {
      return audited(
        "removePrefix",
        () => target(area, prefix),
        async () => {
          const { ref } = await resolve(area, true);
          if (typeof prefix !== "string") {
            throw new InputError(
              'removePrefix needs a prefix ("" for the whole area)',
            );
          }
          return secrets.removePrefix(ref, checkPrefix(prefix));
        },
      );
    },
  };
}
