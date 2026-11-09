import {
  defineTable,
  id,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

/*
 * Stored as p_openbao-secrets_<name>. One small table of named rows:
 *
 * - "secret-id": the AppRole secret ID, sealed with ctx.secrets.seal. Its
 *   updatedBy and updatedAt are who connected OpenBao and when.
 * - "area-key": a random key, sealed, from which each consumer plugin's
 *   area key is derived (see plugin-areas.ts).
 *
 * Secret values themselves are never stored here: they live in OpenBao.
 * Times are ISO strings. No text column has a default: MySQL refuses them.
 */

export const state = defineTable(
  "state",
  {
    id: id(),
    name: varchar(64).notNull().unique(),
    // Sealed. Never sent to a browser.
    value: text().notNull(),
    updatedBy: varchar(255).notNull(),
    updatedAt: timestamp().notNull(),
  },
  {},
);

// termix-plugin migrations reads this list.
export const tables = [state];
