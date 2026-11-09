/**
 * The admin side of the connection: Connect with a response-wrapped token,
 * Disconnect, Test connection, and the status line everyone sees.
 *
 * The AppRole secret ID is never a setting. An admin wraps it in OpenBao
 * (`vault write -wrap-ttl=10m -f auth/approle/role/<role>/secret-id`) and
 * pastes the wrapping token. The backend unwraps it once, seals the secret ID
 * with the installation key and keeps it in its own table. Nobody sees it
 * again: the status only says since when and by whom it is connected.
 */

import { randomBytes } from "node:crypto";
import { ConfigError } from "./config.js";
import { OpenBaoError, type OpenBao } from "./openbao.js";
import type { StateStore } from "./state.js";

/** Wrapping tokens are short; anything longer is not one. */
const WRAPPING_TOKEN = /^[\x21-\x7e]{8,512}$/;

export class ConnectionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectionError";
    this.status = status;
  }
}

export interface ConnectionStatus {
  /** The settings are complete and valid. */
  configured: boolean;
  /** A secret ID is stored. */
  connected: boolean;
  /** When it was connected, ISO time, or null. */
  since: string | null;
  /** The user id that connected it, or null. */
  by: string | null;
  /** What is wrong with the settings, when they are not complete. */
  problem: string | null;
}

export interface TestStep {
  step: "settings" | "login" | "write" | "read" | "delete";
  ok: boolean;
  message: string;
}

export interface TestResult {
  ok: boolean;
  steps: TestStep[];
}

export type Connection = ReturnType<typeof createConnection>;

function reason(error: unknown): string {
  if (error instanceof OpenBaoError || error instanceof ConfigError) {
    return error.message;
  }
  return "failed";
}

export function createConnection(bao: OpenBao, state: StateStore) {
  async function status(): Promise<ConnectionStatus> {
    let configured = true;
    let problem: string | null = null;
    try {
      await bao.readConfig();
    } catch (error) {
      configured = false;
      problem = error instanceof ConfigError ? error.message : "not set up";
    }
    const info = await state.info("secret-id");
    return {
      configured,
      connected: info !== null,
      since: info?.updatedAt ?? null,
      by: info?.updatedBy ?? null,
      problem,
    };
  }

  return {
    status,

    /**
     * Unwraps the token once, keeps the secret ID sealed and logs in to check
     * it. A second use of the same token is refused by OpenBao, and that
     * gives WRAP_TOKEN_SPENT.
     */
    async connect(
      wrappingToken: unknown,
      actor: string,
    ): Promise<ConnectionStatus & { login: TestStep }> {
      if (typeof wrappingToken !== "string") {
        throw new ConnectionError("paste the wrapping token");
      }
      const token = wrappingToken.trim();
      if (!WRAPPING_TOKEN.test(token)) {
        throw new ConnectionError("this is not a wrapping token");
      }
      try {
        await bao.readConfig();
      } catch (error) {
        throw new ConnectionError(
          `save the connection settings first: ${reason(error)}`,
          409,
        );
      }
      let secretId: string;
      try {
        secretId = await bao.unwrap(token);
      } catch (error) {
        throw new ConnectionError(reason(error), 400);
      }
      await state.set("secret-id", secretId, actor);
      bao.reset();
      let login: TestStep;
      try {
        await bao.login();
        login = { step: "login", ok: true, message: "logged in" };
      } catch (error) {
        login = { step: "login", ok: false, message: reason(error) };
      }
      return { ...(await status()), login };
    },

    /** Revokes the token, best effort, and deletes the secret ID. */
    async disconnect(): Promise<ConnectionStatus> {
      await bao.revoke();
      await state.remove("secret-id");
      bao.reset();
      return status();
    },

    /**
     * Logs in, then writes, reads and deletes a probe under
     * <basePath>/_probe/, and reports each step. Stops at the first failure.
     */
    async test(): Promise<TestResult> {
      const steps: TestStep[] = [];
      const done = (): TestResult => ({
        ok: steps.every((step) => step.ok),
        steps,
      });
      let basePath: string;
      try {
        basePath = (await bao.readConfig()).basePath;
        steps.push({ step: "settings", ok: true, message: "complete" });
      } catch (error) {
        steps.push({ step: "settings", ok: false, message: reason(error) });
        return done();
      }
      if (!(await state.info("secret-id"))) {
        steps.push({
          step: "login",
          ok: false,
          message: "OpenBao is not connected: use Connect first",
        });
        return done();
      }
      try {
        const { ttlSeconds } = await bao.login();
        steps.push({
          step: "login",
          ok: true,
          message:
            ttlSeconds === null
              ? "logged in, the token has no end"
              : `logged in, the token lasts ${ttlSeconds} s`,
        });
      } catch (error) {
        steps.push({ step: "login", ok: false, message: reason(error) });
        return done();
      }
      const path = `${basePath}/_probe/${randomBytes(8).toString("hex")}`;
      const value = randomBytes(16).toString("hex");
      try {
        await bao.write(path, value);
        steps.push({ step: "write", ok: true, message: "wrote a probe" });
      } catch (error) {
        steps.push({ step: "write", ok: false, message: reason(error) });
        return done();
      }
      try {
        const read = await bao.read(path);
        steps.push(
          read === value
            ? { step: "read", ok: true, message: "read the probe back" }
            : {
                step: "read",
                ok: false,
                message: "the probe read back differs from what was written",
              },
        );
      } catch (error) {
        steps.push({ step: "read", ok: false, message: reason(error) });
      }
      try {
        await bao.destroy(path);
        steps.push({ step: "delete", ok: true, message: "deleted the probe" });
      } catch (error) {
        steps.push({ step: "delete", ok: false, message: reason(error) });
      }
      return done();
    },
  };
}
