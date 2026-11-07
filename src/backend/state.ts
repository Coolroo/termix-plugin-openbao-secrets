/**
 * The plugin's own rows, read and written through Drizzle on every database
 * Termix supports. Every value is sealed with the installation key, so it
 * can be read without an acting user (the expiry sweep) and never sits in
 * the database in the clear.
 */

import { eq } from "drizzle-orm";
import type {
  PluginContext,
  PluginDatabase,
} from "@termix-ssh/plugin-sdk/backend";
import { state as stateDef } from "./tables.js";

// Drizzle's table and client types are per dialect; treated loosely here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Table = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Drizzle = any;

export type StateName = "secret-id" | "area-key";

export interface StateRow {
  name: StateName;
  /** Unsealed. */
  value: string;
  updatedBy: string;
  updatedAt: string;
}

export type StateStore = Awaited<ReturnType<typeof createStateStore>>;

export async function createStateStore(
  db: PluginDatabase,
  secrets: PluginContext["secrets"],
) {
  const table: Table = await db.define(stateDef);
  const client = (): Promise<Drizzle> => db.client<Drizzle>();

  async function read(
    name: StateName,
  ): Promise<Omit<StateRow, "value"> & { sealed: string } | null> {
    const rows = await (await client())
      .select()
      .from(table)
      .where(eq(table.name, name))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      name,
      sealed: String(row.value),
      updatedBy: String(row.updatedBy),
      updatedAt: String(row.updatedAt),
    };
  }

  return {
    /** The row without its value: who set it and when. */
    async info(
      name: StateName,
    ): Promise<{ updatedBy: string; updatedAt: string } | null> {
      const row = await read(name);
      return row ? { updatedBy: row.updatedBy, updatedAt: row.updatedAt } : null;
    },

    /** The unsealed value, or null when unset or no longer readable. */
    async get(name: StateName): Promise<string | null> {
      const row = await read(name);
      if (!row) return null;
      return secrets.unseal(row.sealed);
    },

    async set(name: StateName, value: string, by: string): Promise<void> {
      const sealed = await secrets.seal(value);
      const at = new Date().toISOString();
      const drizzle = await client();
      await drizzle.delete(table).where(eq(table.name, name));
      await drizzle
        .insert(table)
        .values({ name, value: sealed, updatedBy: by, updatedAt: at });
      await db.persist();
    },

    async remove(name: StateName): Promise<boolean> {
      const existing = await read(name);
      if (!existing) return false;
      await (await client()).delete(table).where(eq(table.name, name));
      await db.persist();
      return true;
    },
  };
}
