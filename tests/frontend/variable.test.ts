import { describe, expect, it, vi } from "vitest";
import {
  isValidVariableName,
  MAX_VARIABLE_LENGTH,
  variableNameFor,
  variableValueProblem,
} from "../../src/shared/names";
import {
  putInVariable,
  readCommand,
  READ_START_MS,
  typeInto,
  type PickTarget,
} from "../../src/frontend/terminal";

const target: PickTarget = {
  sessionId: "tab-1",
  hostId: 1,
  auditSessionId: "ssh-1",
  label: null,
};

describe("variable names", () => {
  it("derives the default from the secret's name", () => {
    expect(variableNameFor("runbook-test")).toBe("RUNBOOK_TEST");
    expect(variableNameFor("db/prod/root")).toBe("DB_PROD_ROOT");
    expect(variableNameFor("api.token_2")).toBe("API_TOKEN_2");
    expect(variableNameFor("1password")).toBe("_1PASSWORD");
    expect(variableNameFor("path")).toBe("SECRET_PATH");
    expect(variableNameFor("ifs")).toBe("SECRET_IFS");
    expect(variableNameFor("histfile")).toBe("SECRET_HISTFILE");
    expect(variableNameFor("--")).toBe("SECRET");
    expect(variableNameFor("a".repeat(200))).toHaveLength(MAX_VARIABLE_LENGTH);
    for (const name of ["runbook-test", "1password", "path", "--", "x/y.z"]) {
      expect(isValidVariableName(variableNameFor(name))).toBe(true);
    }
  });

  it("takes letters, digits and _, not starting with a digit", () => {
    for (const good of ["A", "_x", "RUNBOOK_TEST", "token2", "a_B_9"]) {
      expect(isValidVariableName(good)).toBe(true);
    }
    for (const bad of [
      "",
      "1A",
      "A-B",
      "A B",
      "A;id",
      "$(id)",
      "A\nB",
      "É",
      "a".repeat(MAX_VARIABLE_LENGTH + 1),
      7,
      null,
    ]) {
      expect(isValidVariableName(bad)).toBe(false);
    }
  });

  it("refuses names the shell uses", () => {
    for (const shell of ["PATH", "path", "IFS", "PS1", "HOME", "_"]) {
      expect(isValidVariableName(shell)).toBe(false);
    }
    for (const shell of ["BASH_ENV", "HISTFILE", "HISTCONTROL", "LC_ALL"]) {
      expect(isValidVariableName(shell)).toBe(false);
    }
  });

  it("refuses values one read line cannot hold", () => {
    expect(variableValueProblem("s3cret with spaces\tand a tab")).toBeNull();
    expect(variableValueProblem("a\nb")).toBe("multiline");
    expect(variableValueProblem("a\rb")).toBe("multiline");
    expect(variableValueProblem("a\u0003b")).toBe("control");
    expect(variableValueProblem("a\u001bb")).toBe("control");
    expect(variableValueProblem("a\u007fb")).toBe("control");
    expect(variableValueProblem("x".repeat(4000))).toBeNull();
    expect(variableValueProblem("x".repeat(4001))).toBe("long");
    expect(variableValueProblem("é".repeat(2001))).toBe("long");
  });
});

describe("putInVariable", () => {
  it("sends read -rs with a space first, waits, then the value, each with Enter", async () => {
    const order: string[] = [];
    const invoke = vi.fn(async (id: string, ...args: unknown[]) => {
      order.push(`${id}:${JSON.stringify(args)}`);
      return true;
    });
    const wait = vi.fn(async (ms: number) => {
      order.push(`wait:${ms}`);
    });
    expect(await putInVariable(invoke, target, "TOKEN", "v4lue", wait)).toBe(
      true,
    );
    expect(readCommand("TOKEN")).toBe(" IFS= read -rs TOKEN");
    expect(order).toEqual([
      `terminal.sendToSession:${JSON.stringify(["tab-1", " IFS= read -rs TOKEN", { run: true }])}`,
      `wait:${READ_START_MS}`,
      `terminal.sendToSession:${JSON.stringify(["tab-1", "v4lue", { run: true }])}`,
    ]);
  });

  it("uses the active session when there is no one target", async () => {
    const invoke = vi.fn(async () => true);
    await putInVariable(
      invoke,
      { ...target, sessionId: null },
      "TOKEN",
      "v4lue",
      async () => {},
    );
    expect(invoke.mock.calls).toEqual([
      ["terminal.sendToActive", " IFS= read -rs TOKEN", { run: true }],
      ["terminal.sendToActive", "v4lue", { run: true }],
    ]);
  });

  it("never sends the value when the read line was not taken", async () => {
    for (const first of [false, new Error("no terminal")]) {
      const invoke = vi.fn(async () => {
        if (first instanceof Error) throw first;
        return first;
      });
      expect(
        await putInVariable(invoke, target, "TOKEN", "v4lue", async () => {}),
      ).toBe(false);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(invoke.mock.calls)).not.toContain("v4lue");
    }
  });

  it("leaves Type at the cursor as it was: a paste, without Enter", async () => {
    const invoke = vi.fn(async () => true);
    expect(await typeInto(invoke, target, "v4lue")).toBe(true);
    expect(invoke.mock.calls).toEqual([
      ["terminal.sendToSession", "tab-1", "v4lue", { run: false }],
    ]);
  });
});
