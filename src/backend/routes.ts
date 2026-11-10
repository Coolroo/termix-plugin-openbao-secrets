/**
 * /plugin-api/openbao-secrets/..., behind core's login.
 *
 * - The Secrets tab: names and metadata, never a value (GET /secrets).
 * - Add, replace and delete. Shared secrets need manage-shared.
 * - POST /type: the one route that answers with a value, for the terminal
 *   picker. It is audited, never cached, and refused for a core API key, so
 *   a script holding a key cannot read secrets through it.
 * - /admin/...: Connect, Disconnect and Test connection, for whoever may
 *   manage plugins (admin.plugins.manage), never for an API key.
 *
 * Every error is a status and a short message. None carries a value.
 */

import type { NextFunction, Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConfigError } from "./config.js";
import { ConnectionError, type Connection } from "./connection.js";
import { OpenBaoError } from "./openbao.js";
import { AreaError } from "./plugin-areas.js";
import {
  checkName,
  checkValue,
  InputError,
  type AreaRef,
  type SecretEntry,
  type Secrets,
} from "./secrets.js";
import {
  isValidVariableName,
  MAX_VARIABLE_LENGTH,
  MAX_VARIABLE_VALUE_BYTES,
  variableValueProblem,
} from "../shared/names.js";

/** Core's permission for plugin settings; admins hold it. */
export const ADMIN_PERMISSION = "admin.plugins.manage";

type Section = "user" | "shared";
type Handler = (req: Request, res: Response) => Promise<void>;

/** An error a route answers with on purpose: never a crash. */
function statusOf(error: unknown): number | null {
  if (
    error instanceof InputError ||
    error instanceof AreaError ||
    error instanceof ConnectionError ||
    error instanceof ConfigError
  ) {
    return error.status;
  }
  // OpenBao answered badly or not at all: a bad gateway, not our crash.
  if (error instanceof OpenBaoError) return 502;
  return null;
}

function wrap(fn: (req: Request, res: Response) => Promise<unknown>): Handler {
  return async (req, res) => {
    try {
      const body = await fn(req, res);
      if (!res.headersSent) res.json(body);
    } catch (error) {
      const status = statusOf(error);
      if (status === null) throw error;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

function section(value: unknown): Section {
  if (value === "user" || value === "shared") return value;
  throw new InputError('section is "user" or "shared"');
}

/** Why a value cannot go in a shell variable. Never the value itself. */
const VALUE_PROBLEMS = {
  multiline:
    "this secret has more than one line, so it cannot go in a variable: type it at the cursor",
  control:
    "this secret has a control character, so it cannot go in a variable: type it at the cursor",
  long: `this secret is longer than ${MAX_VARIABLE_VALUE_BYTES} bytes, more than one terminal line takes: type it at the cursor`,
} as const;

/**
 * POST /type's mode: null to type at the cursor (the default), or the
 * shell variable's name for "Put in a variable".
 */
function variableMode(input: Record<string, unknown>): string | null {
  if (input.mode === undefined || input.mode === "cursor") return null;
  if (input.mode !== "variable") {
    throw new InputError('mode is "cursor" or "variable"');
  }
  if (!isValidVariableName(input.variable)) {
    throw new InputError(
      `a variable name is letters, digits and '_', not starting with a digit, at most ${MAX_VARIABLE_LENGTH} characters, and not one the shell uses`,
    );
  }
  return input.variable;
}

/** What the tab may see of a secret: everything but the value. */
function view(entry: SecretEntry) {
  return {
    name: entry.name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    createdBy: entry.createdBy,
    expiresAt: entry.expiresAt,
    note: entry.note,
  };
}

export function registerRoutes(
  router: Router,
  ctx: PluginContext,
  secrets: Secrets,
  connection: Connection,
): void {
  const actor = () => ctx.currentActor() as string;

  const signedIn = (_req: Request, res: Response, next: NextFunction) => {
    if (!ctx.currentActor()) {
      res.status(401).json({ error: "sign in to Termix first" });
      return;
    }
    next();
  };
  const notApiKey = (req: Request, res: Response, next: NextFunction) => {
    if ((req as Request & { apiKeyId?: unknown }).apiKeyId) {
      res.status(403).json({
        error: "a Termix API key cannot do this; use the Termix app",
      });
      return;
    }
    next();
  };
  const admin = async (_req: Request, res: Response, next: NextFunction) => {
    if (!(await ctx.rbac.has(ADMIN_PERMISSION))) {
      res
        .status(403)
        .json({ error: "only an admin can manage the OpenBao connection" });
      return;
    }
    next();
  };
  const use = [signedIn, ctx.rbac.require("use") as never];
  const adminOnly = [signedIn, notApiKey, admin];

  function area(name: Section): AreaRef {
    return name === "user"
      ? { kind: "user", userId: actor() }
      : { kind: "shared" };
  }

  /** Shared writes need manage-shared on top of use. */
  async function mayWrite(name: Section): Promise<void> {
    if (name === "shared" && !(await ctx.rbac.has("manage-shared"))) {
      throw new AreaError("you need the Manage shared secrets permission");
    }
  }

  async function connected(): Promise<void> {
    const status = await connection.status();
    if (!status.configured || !status.connected) {
      throw new ConnectionError(
        "OpenBao Secrets is not connected: ask an admin to connect it",
        409,
      );
    }
  }

  async function audit(
    req: Request,
    action: string,
    target: string,
    success: boolean,
    details: string,
    errorMessage?: string,
  ): Promise<void> {
    await ctx.audit.record({
      action: `openbao_secrets_${action}`,
      resourceType: "openbao_secret",
      resourceName: target.slice(0, 250),
      details,
      success,
      ...(errorMessage ? { errorMessage } : {}),
      request: req,
    });
  }

  /** Runs a write and audits it, success or not. */
  async function audited<T>(
    req: Request,
    action: string,
    target: string,
    details: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn();
      await audit(req, action, target, true, details);
      return result;
    } catch (error) {
      await audit(
        req,
        action,
        target,
        false,
        details,
        error instanceof Error ? error.message : "failed",
      );
      throw error;
    }
  }

  /**
   * @openapi
   * /plugin-api/openbao-secrets/status:
   *   get:
   *     summary: Whether OpenBao is connected, and what the user may do
   *     tags:
   *       - OpenBao Secrets
   *     responses:
   *       200:
   *         description: configured, connected, since, canManageShared, isAdmin
   *       403:
   *         description: The user lacks the Use secrets permission
   */
  router.get(
    "/status",
    ...use,
    wrap(async () => {
      const status = await connection.status();
      return {
        configured: status.configured,
        connected: status.connected,
        since: status.since,
        canManageShared: await ctx.rbac.has("manage-shared"),
        isAdmin: await ctx.rbac.has(ADMIN_PERMISSION),
      };
    }),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/secrets:
   *   get:
   *     summary: The names of your secrets and the shared ones, never a value
   *     tags:
   *       - OpenBao Secrets
   *     responses:
   *       200:
   *         description: "{ user: [...], shared: [...] }, each entry with name, times, createdBy, expiresAt and note"
   *       403:
   *         description: The user lacks the Use secrets permission
   *       409:
   *         description: OpenBao is not connected
   *       502:
   *         description: OpenBao refused the request or did not answer
   */
  router.get(
    "/secrets",
    ...use,
    wrap(async () => {
      await connected();
      const [user, shared] = await Promise.all([
        secrets.list(area("user")),
        secrets.list(area("shared")),
      ]);
      return { user: user.map(view), shared: shared.map(view) };
    }),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/secrets:
   *   post:
   *     summary: Add a secret
   *     tags:
   *       - OpenBao Secrets
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [section, name, value]
   *             properties:
   *               section:
   *                 type: string
   *                 enum: [user, shared]
   *               name:
   *                 type: string
   *               value:
   *                 type: string
   *               note:
   *                 type: string
   *     responses:
   *       201:
   *         description: The new secret's entry, without its value
   *       400:
   *         description: A name, value or note that is not valid
   *       403:
   *         description: Use secrets, or Manage shared secrets for a shared one, is missing
   *       409:
   *         description: A secret with this name exists, or OpenBao is not connected
   */
  router.post(
    "/secrets",
    ...use,
    wrap(async (req, res) => {
      const input = body(req);
      const where = section(input.section);
      const name = checkName(input.name);
      const value = checkValue(input.value);
      await mayWrite(where);
      await connected();
      const entry = await audited(
        req,
        "add",
        `${where}/${name}`,
        "added a secret",
        async () => {
          if (await secrets.describe(area(where), name)) {
            throw new InputError(
              "a secret with this name exists: use Replace value",
              409,
            );
          }
          return secrets.put(
            area(where),
            name,
            value,
            { note: input.note ?? null },
            actor(),
          );
        },
      );
      res.status(201);
      return view(entry);
    }),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/secrets:
   *   put:
   *     summary: Replace a secret's value, keeping its note and expiry
   *     tags:
   *       - OpenBao Secrets
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [section, name, value]
   *             properties:
   *               section:
   *                 type: string
   *                 enum: [user, shared]
   *               name:
   *                 type: string
   *               value:
   *                 type: string
   *     responses:
   *       200:
   *         description: The secret's entry, without its value
   *       403:
   *         description: Use secrets, or Manage shared secrets for a shared one, is missing
   *       404:
   *         description: No secret has this name
   */
  router.put(
    "/secrets",
    ...use,
    wrap(async (req) => {
      const input = body(req);
      const where = section(input.section);
      const name = checkName(input.name);
      const value = checkValue(input.value);
      await mayWrite(where);
      await connected();
      const entry = await audited(
        req,
        "replace",
        `${where}/${name}`,
        "replaced a secret's value",
        async () => {
          const existing = await secrets.describe(area(where), name);
          if (!existing) throw new InputError("no secret has this name", 404);
          return secrets.put(
            area(where),
            name,
            value,
            { note: existing.note, expiresAt: existing.expiresAt },
            actor(),
          );
        },
      );
      return view(entry);
    }),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/secrets:
   *   delete:
   *     summary: Delete a secret with every version
   *     tags:
   *       - OpenBao Secrets
   *     parameters:
   *       - in: query
   *         name: section
   *         required: true
   *         schema:
   *           type: string
   *           enum: [user, shared]
   *       - in: query
   *         name: name
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ deleted: true }"
   *       403:
   *         description: Use secrets, or Manage shared secrets for a shared one, is missing
   *       404:
   *         description: No secret has this name
   */
  router.delete(
    "/secrets",
    ...use,
    wrap(async (req) => {
      const where = section(req.query.section);
      const name = checkName(req.query.name);
      await mayWrite(where);
      await connected();
      await audited(
        req,
        "delete",
        `${where}/${name}`,
        "deleted a secret",
        async () => {
          if (!(await secrets.remove(area(where), name))) {
            throw new InputError("no secret has this name", 404);
          }
        },
      );
      return { deleted: true };
    }),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/type:
   *   post:
   *     summary: Read one value to type into a terminal (audited, never cached)
   *     description: The only route that answers with a value. Refused for a Termix API key.
   *     tags:
   *       - OpenBao Secrets
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [section, name]
   *             properties:
   *               section:
   *                 type: string
   *                 enum: [user, shared]
   *               name:
   *                 type: string
   *               sessionId:
   *                 type: string
   *                 description: The terminal session the value goes to, for the audit line
   *               hostId:
   *                 type: number
   *                 description: The terminal's host, for the audit line
   *               mode:
   *                 type: string
   *                 enum: [cursor, variable]
   *                 description: Typed at the cursor (the default), or put in a shell variable with read -rs
   *               variable:
   *                 type: string
   *                 description: The shell variable's name, with mode variable, for the audit line
   *     responses:
   *       200:
   *         description: "{ value }"
   *       403:
   *         description: Use secrets is missing, or the call came with an API key
   *       404:
   *         description: No secret has this name
   *       422:
   *         description: With mode variable, the value has a line break or a control character, or is too long for one terminal line
   */
  router.post(
    "/type",
    ...use,
    notApiKey,
    wrap(async (req, res) => {
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      const input = body(req);
      const where = section(input.section);
      const name = checkName(input.name);
      const sessionId =
        typeof input.sessionId === "string"
          ? input.sessionId.replace(/[^\w.:-]/g, "").slice(0, 100)
          : "";
      const hostId =
        typeof input.hostId === "number" && Number.isInteger(input.hostId)
          ? input.hostId
          : typeof input.hostId === "string" && /^\d{1,12}$/.test(input.hostId)
            ? Number(input.hostId)
            : null;
      const variable = variableMode(input);
      await connected();
      const terminal = `session ${sessionId || "unknown"}, host ${hostId ?? "unknown"}`;
      const details = variable
        ? `put a secret in a shell variable (mode variable, variable ${variable}, ${terminal})`
        : `typed a secret into a terminal (${terminal})`;
      const value = await audited(
        req,
        "type",
        `${where}/${name}`,
        details,
        async () => {
          const found = await secrets.get(area(where), name);
          if (found === null) {
            throw new InputError("no secret has this name", 404);
          }
          const problem = variable ? variableValueProblem(found) : null;
          if (problem) throw new InputError(VALUE_PROBLEMS[problem], 422);
          return found;
        },
      );
      return { value };
    }),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/admin/connection:
   *   get:
   *     summary: The connection as an admin sees it
   *     tags:
   *       - OpenBao Secrets
   *     responses:
   *       200:
   *         description: configured, connected, since, by (a user id) and what is wrong with the settings
   *       403:
   *         description: Not an admin, or an API key
   */
  router.get(
    "/admin/connection",
    ...adminOnly,
    wrap(async () => connection.status()),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/admin/connect:
   *   post:
   *     summary: Connect with a response-wrapped AppRole secret ID
   *     tags:
   *       - OpenBao Secrets
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [wrappingToken]
   *             properties:
   *               wrappingToken:
   *                 type: string
   *     responses:
   *       200:
   *         description: The new status, and whether the first login worked
   *       400:
   *         description: The token was already used, has expired or is not a wrapping token
   *       403:
   *         description: Not an admin, or an API key
   *       409:
   *         description: The connection settings are not saved yet
   */
  router.post(
    "/admin/connect",
    ...adminOnly,
    wrap(async (req) => {
      const result = await audited(
        req,
        "connect",
        "connection",
        "connected OpenBao",
        () => connection.connect(body(req).wrappingToken, actor()),
      );
      return result;
    }),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/admin/disconnect:
   *   post:
   *     summary: Disconnect, deleting the stored secret ID
   *     tags:
   *       - OpenBao Secrets
   *     responses:
   *       200:
   *         description: The new status
   *       403:
   *         description: Not an admin, or an API key
   */
  router.post(
    "/admin/disconnect",
    ...adminOnly,
    wrap(async (req) =>
      audited(req, "disconnect", "connection", "disconnected OpenBao", () =>
        connection.disconnect(),
      ),
    ),
  );

  /**
   * @openapi
   * /plugin-api/openbao-secrets/admin/test:
   *   post:
   *     summary: Log in, write, read and delete a probe, and report each step
   *     tags:
   *       - OpenBao Secrets
   *     responses:
   *       200:
   *         description: "{ ok, steps: [{ step, ok, message }] }"
   *       403:
   *         description: Not an admin, or an API key
   */
  router.post(
    "/admin/test",
    ...adminOnly,
    wrap(async () => connection.test()),
  );
}
