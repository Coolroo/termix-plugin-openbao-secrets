import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { KeybindingActionContribution } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../src/frontend/index";
import { PICKER_PANEL, TAB_ID, TYPE_ACTION } from "../../src/frontend/index";
import { clearPick, pendingPick } from "../../src/frontend/terminal";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const shell = vi.hoisted(() => ({
  tabs: { setActive: (_id: string) => {} },
}));

const toasts = vi.hoisted(() => ({
  success: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
}));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  const toast = Object.assign(
    (...args: Parameters<typeof actual.toast>) => actual.toast(...args),
    actual.toast,
    {
      success: (...args: unknown[]) => toasts.success(...args),
      error: (...args: unknown[]) => toasts.error(...args),
    },
  );
  return { ...actual, toast };
});

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>();
  return { ...actual, useShell: () => shell };
});

const manifest = manifestJson as unknown as PluginManifest;
const VALUE = "correct-horse-battery";

const lists = {
  user: [
    {
      name: "db/prod/root",
      createdAt: "2026-11-09T10:00:00.000Z",
      updatedAt: "2026-11-09T10:00:00.000Z",
      createdBy: "alice",
      expiresAt: null,
      note: "rotated monthly",
    },
  ],
  shared: [
    {
      name: "wifi",
      createdAt: "2026-11-09T10:00:00.000Z",
      updatedAt: "2026-11-09T10:00:00.000Z",
      createdBy: "bob",
      expiresAt: null,
      note: null,
    },
  ],
};

const status = {
  configured: true,
  connected: true,
  since: "2026-11-09T09:00:00.000Z",
  canManageShared: true,
  isAdmin: true,
};

let rendered: RenderedPluginApp | null = null;
let keybinding: KeybindingActionContribution | null = null;

interface Fakes {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

async function setup(
  options: { status?: typeof status; post?: Fakes["post"] } = {},
): Promise<Fakes> {
  const fakes: Fakes = {
    get: vi.fn(async (url: string) => ({
      data:
        url === "/status"
          ? (options.status ?? status)
          : url === "/admin/connection"
            ? {
                configured: true,
                connected: false,
                since: null,
                by: null,
                problem: null,
              }
            : lists,
    })),
    post:
      options.post ??
      vi.fn(async (url: string) => ({
        data: url === "/type" ? { value: VALUE } : {},
      })),
    put: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: { deleted: true } })),
  };
  rendered = await renderWithApp(
    {
      // Keeps the keybinding action, which the test host does not run.
      activate: (app) => {
        const register = app.registerKeybindingAction;
        app.registerKeybindingAction = (action) => {
          keybinding = action;
          return register(action);
        };
        return plugin.activate(app);
      },
    },
    {
      manifest,
      locales,
      permissions: ["openbao-secrets.use", "openbao-secrets.manage-shared"],
      api: { ...fakes, patch: vi.fn() } as never,
    },
  );
  return fakes;
}

beforeEach(() => {
  shell.tabs.setActive = vi.fn();
  toasts.success = vi.fn();
  toasts.error = vi.fn();
  clearPick();
});

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe("activate", () => {
  it("registers the tab, the settings component and the terminal points", async () => {
    await setup();
    const { registered } = rendered!;
    expect(registered.tabs()).toContain(TAB_ID);
    expect(registered.railItems().map((item) => item.id)).toContain(TAB_ID);
    expect(registered.settingsComponents()).toContain("connection");
    expect(registered.slot("terminal.toolbar")).toContain(TYPE_ACTION);
    expect(registered.slot("terminal.sidePanel")).toContain(PICKER_PANEL);
    expect(registered.keybindingActions()).toContain(TYPE_ACTION);
    expect(registered.actions()).toEqual(
      expect.arrayContaining([TYPE_ACTION, PICKER_PANEL]),
    );
  });

  it("the toolbar button opens the picker beside its terminal", async () => {
    await setup();
    const openSidePanel = vi.fn();
    await rendered!.app.invokeAction(TYPE_ACTION, {
      host: { id: 1 },
      sessionId: () => "ssh-session-9",
      openSidePanel,
    });
    expect(openSidePanel).toHaveBeenCalledWith(PICKER_PANEL, {
      auditSessionId: "ssh-session-9",
    });
  });
});

describe("the Secrets tab", () => {
  it("renders names only and never asks for a value", async () => {
    const fakes = await setup();
    rendered!.renderTab(TAB_ID, { isVisible: true });
    expect(await screen.findByText("wifi")).toBeTruthy();
    expect(screen.getByText("db")).toBeTruthy();
    expect(document.body.textContent).not.toContain(VALUE);
    expect(fakes.get.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(["/status", "/secrets"]),
    );
    expect(fakes.post).not.toHaveBeenCalled();
    // No reveal and no copy anywhere.
    expect(screen.queryByText(/reveal|show value|copy/i)).toBeNull();
  });

  it("asks a person without a connection to see an admin", async () => {
    await setup({ status: { ...status, connected: false, isAdmin: false } });
    rendered!.renderTab(TAB_ID, { isVisible: true });
    expect(await screen.findByText(locales.status.notConnected)).toBeTruthy();
  });

  async function openAdd() {
    const fakes = await setup();
    rendered!.renderTab(TAB_ID, { isVisible: true });
    await screen.findByText("wifi");
    fireEvent.click(screen.getAllByText(locales.list.add)[0]);
    const name = await screen.findByPlaceholderText(
      locales.form.namePlaceholder,
    );
    fireEvent.change(name, { target: { value: "api/token" } });
    const field = document.querySelector(
      'textarea[data-secret-value="true"]',
    ) as HTMLTextAreaElement;
    const add = () =>
      screen.getByText(locales.form.add).closest("button") as HTMLButtonElement;
    return { fakes, field, add };
  }

  it("adds a secret through the value field, which shows the value", async () => {
    const { fakes, field, add } = await openAdd();
    expect(field).toBeTruthy();
    expect(add().disabled).toBe(true);
    fireEvent.change(field, { target: { value: "ab\ncd" } });
    expect(field.value).toBe("ab\ncd");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(add().disabled).toBe(false);
    fireEvent.click(add());
    await waitFor(() =>
      expect(fakes.post).toHaveBeenCalledWith("/secrets", {
        section: "user",
        name: "api/token",
        value: "ab\ncd",
      }),
    );
  });

  it("takes a phone keyboard's word that is still being composed", async () => {
    const { field, add } = await openAdd();
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "hello" } });
    // No compositionend: Android keyboards may keep composing until blur.
    expect(add().disabled).toBe(false);
  });

  it("hides and shows the value without changing it", async () => {
    const { fakes, field, add } = await openAdd();
    fireEvent.change(field, { target: { value: "s3cret" } });
    const toggle = screen.getByText(locales.form.hide);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    // jsdom drops -webkit-text-security, so the dots are checked by the flag.
    expect(field.getAttribute("data-hidden")).toBe("true");
    expect(
      screen.getByText(locales.form.show).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.change(field, { target: { value: "s3cret!" } });
    fireEvent.click(screen.getByText(locales.form.show));
    expect(field.getAttribute("data-hidden")).toBe("false");
    expect(field.value).toBe("s3cret!");
    fireEvent.click(add());
    await waitFor(() =>
      expect(fakes.post).toHaveBeenCalledWith("/secrets", {
        section: "user",
        name: "api/token",
        value: "s3cret!",
      }),
    );
  });

  it("gives each row icon buttons named Replace value and Delete", async () => {
    await setup();
    rendered!.renderTab(TAB_ID, { isVisible: true });
    await screen.findByText("wifi");
    const row = document.querySelector('[data-secret$="/wifi"]') as HTMLElement;
    const replace = within(row).getByRole("button", {
      name: locales.list.replace,
    });
    const remove = within(row).getByRole("button", {
      name: locales.list.delete,
    });
    for (const button of [replace, remove]) {
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).toBeTruthy();
      expect(button.getAttribute("title")).toBe(
        button.getAttribute("aria-label"),
      );
    }
    fireEvent.click(replace);
    expect(
      await screen.findByText(
        locales.form.replaceTitle.replace("{{name}}", "wifi"),
      ),
    ).toBeTruthy();
  });
});

describe("the picker", () => {
  async function openPanel(sessions: unknown[]) {
    const sendToSession = vi.fn(() => true);
    const sendToActive = vi.fn(() => true);
    rendered!.app.registerAction("terminal.listSessions", () => sessions);
    rendered!.app.registerAction(
      "terminal.sendToSession",
      sendToSession as never,
    );
    rendered!.app.registerAction(
      "terminal.sendToActive",
      sendToActive as never,
    );
    const onClose = vi.fn();
    rendered!.renderSlot("terminal.sidePanel", {
      host: { id: "1", ip: "10.0.0.1", username: "root" },
      hostId: 1,
      hostLabel: "root@web",
      panelProps: { auditSessionId: "ssh-session-9" },
      onClose,
      onRunInTerminal: vi.fn(),
    });
    return { sendToSession, sendToActive, onClose };
  }

  it("shows the caution and types with run: false, without Enter", async () => {
    const fakes = await setup();
    const { sendToSession, onClose } = await openPanel([
      { id: "tab-1", hostId: 1, visible: true, connected: true },
      { id: "tab-2", hostId: 2, visible: true, connected: true },
    ]);
    expect(await screen.findByText(locales.picker.caution)).toBeTruthy();
    fireEvent.click(await screen.findByText("wifi"));
    fireEvent.click(await screen.findByText(locales.picker.typeAtCursor));
    await waitFor(() =>
      expect(sendToSession).toHaveBeenCalledWith("tab-1", VALUE, {
        run: false,
      }),
    );
    expect(fakes.post).toHaveBeenCalledWith("/type", {
      section: "shared",
      name: "wifi",
      sessionId: "ssh-session-9",
      hostId: 1,
    });
    expect(document.body.textContent).not.toContain(VALUE);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("falls back to the active session when the terminal is not one", async () => {
    await setup();
    const { sendToSession, sendToActive } = await openPanel([
      { id: "tab-1", hostId: 1, visible: true, connected: true },
      { id: "tab-3", hostId: 1, visible: true, connected: true },
    ]);
    fireEvent.click(await screen.findByText("wifi"));
    fireEvent.click(await screen.findByText(locales.picker.typeAtCursor));
    await waitFor(() =>
      expect(sendToActive).toHaveBeenCalledWith(VALUE, { run: false }),
    );
    expect(sendToSession).not.toHaveBeenCalled();
  });

  /** Opens "Put in a variable" for the shared secret "wifi". */
  async function openVariable() {
    fireEvent.click(await screen.findByText("wifi"));
    fireEvent.click(await screen.findByText(locales.picker.putInVariable));
    const field = document.querySelector(
      "[data-variable-form] input",
    ) as HTMLInputElement;
    return {
      field,
      put: () =>
        fireEvent.click(
          screen.getByText(locales.picker.putButton).closest("button")!,
        ),
    };
  }

  it("puts a secret in a variable: read -rs, Enter, the value, Enter", async () => {
    const fakes = await setup();
    const { sendToSession, sendToActive, onClose } = await openPanel([
      { id: "tab-1", hostId: 1, visible: true, connected: true },
      { id: "tab-2", hostId: 2, visible: true, connected: true },
    ]);
    const { field, put } = await openVariable();
    // The caution shows every time, and the name comes from the secret's.
    expect(screen.getByText(locales.picker.variableCaution)).toBeTruthy();
    expect(
      document.querySelector('[data-caution="variable"]')?.textContent,
    ).toContain("bash or zsh prompt");
    expect(field.value).toBe("WIFI");
    put();
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(2));
    expect(sendToSession.mock.calls).toEqual([
      ["tab-1", " IFS= read -rs WIFI", { run: true }],
      ["tab-1", VALUE, { run: true }],
    ]);
    expect(sendToActive).not.toHaveBeenCalled();
    // What the terminal gets: run: true types the text, then "\r".
    const typed = (
      sendToSession.mock.calls as unknown as [
        string,
        string,
        { run: boolean },
      ][]
    )
      .map(([, text, opts]) => text + (opts.run ? "\r" : ""))
      .join("");
    expect(typed).toBe(` IFS= read -rs WIFI\r${VALUE}\r`);
    expect(fakes.post).toHaveBeenCalledWith("/type", {
      section: "shared",
      name: "wifi",
      sessionId: "ssh-session-9",
      hostId: 1,
      mode: "variable",
      variable: "WIFI",
    });
    expect(toasts.success).toHaveBeenCalledWith(
      'Put wifi in $WIFI. Use "$WIFI" in commands, and run unset WIFI when done.',
    );
    expect(document.body.textContent).not.toContain(VALUE);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("takes the variable name the person gives", async () => {
    const fakes = await setup();
    const { sendToSession } = await openPanel([
      { id: "tab-1", hostId: 1, visible: true, connected: true },
    ]);
    const { field, put } = await openVariable();
    fireEvent.change(field, { target: { value: "wifi_pass2" } });
    put();
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(2));
    expect(sendToSession.mock.calls[0]).toEqual([
      "tab-1",
      " IFS= read -rs wifi_pass2",
      { run: true },
    ]);
    expect(fakes.post).toHaveBeenCalledWith(
      "/type",
      expect.objectContaining({ mode: "variable", variable: "wifi_pass2" }),
    );
  });

  it("refuses a bad variable name with a message, and types nothing", async () => {
    const fakes = await setup();
    const { sendToSession, sendToActive } = await openPanel([
      { id: "tab-1", hostId: 1, visible: true, connected: true },
    ]);
    const { field, put } = await openVariable();
    for (const bad of ["1WIFI", "WI-FI", "", "wifi pass", "$(id)"]) {
      fireEvent.change(field, { target: { value: bad } });
      expect(
        screen.getByText(locales.picker.variableRule.replace("{{max}}", "64")),
      ).toBeTruthy();
      put();
    }
    fireEvent.change(field, { target: { value: "PATH" } });
    expect(
      screen.getByText(
        locales.picker.variableShell.replace("{{variable}}", "PATH"),
      ),
    ).toBeTruthy();
    put();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakes.post).not.toHaveBeenCalled();
    expect(sendToSession).not.toHaveBeenCalled();
    expect(sendToActive).not.toHaveBeenCalled();
  });

  it("types nothing when the value cannot go in a variable", async () => {
    const post = vi.fn(async () => ({ data: { value: "line one\nrm -rf ~" } }));
    await setup({ post: post as never });
    const { sendToSession, onClose } = await openPanel([
      { id: "tab-1", hostId: 1, visible: true, connected: true },
    ]);
    const { put } = await openVariable();
    put();
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(locales.picker.variableUnfit),
    );
    expect(sendToSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Back returns from the variable name to the two choices", async () => {
    await setup();
    await openPanel([
      { id: "tab-1", hostId: 1, visible: true, connected: true },
    ]);
    await openVariable();
    fireEvent.click(screen.getByText(locales.picker.back));
    expect(screen.getByText(locales.picker.typeAtCursor)).toBeTruthy();
    expect(screen.getByText(locales.picker.putInVariable)).toBeTruthy();
    fireEvent.click(screen.getByText(locales.picker.back));
    expect(await screen.findByText("wifi")).toBeTruthy();
  });

  it("the keybinding opens the tab in pick mode and returns to the terminal", async () => {
    await setup();
    const sendToSession = vi.fn(() => true);
    rendered!.app.registerAction("terminal.listSessions", () => [
      {
        id: "tab-5",
        hostId: 4,
        ip: "10.0.0.4",
        username: "root",
        label: "web-4",
        visible: true,
        connected: true,
      },
    ]);
    rendered!.app.registerAction(
      "terminal.sendToSession",
      sendToSession as never,
    );
    // The keybinding run, as the terminal hands it on: no session id,
    // only the host and a send.
    expect(keybinding?.scope).toBe("session");
    await act(async () => {
      keybinding!.run!({ type: TYPE_ACTION } as never, {
        host: { ip: "10.0.0.4", username: "root" },
        send: vi.fn(),
      });
      await waitFor(() => expect(pendingPick()?.sessionId).toBe("tab-5"));
    });
    expect(
      rendered!.shellCalls.some((call) => call.method === "openSingletonTab"),
    ).toBe(true);
    rendered!.renderTab(TAB_ID, { isVisible: true });
    expect(await screen.findByText(locales.picker.caution)).toBeTruthy();
    expect(screen.getByText("Into web-4")).toBeTruthy();
    fireEvent.click(await screen.findByText("wifi"));
    fireEvent.click(await screen.findByText(locales.picker.typeAtCursor));
    await waitFor(() =>
      expect(sendToSession).toHaveBeenCalledWith("tab-5", VALUE, {
        run: false,
      }),
    );
    await waitFor(() =>
      expect(shell.tabs.setActive).toHaveBeenCalledWith("tab-5"),
    );
    expect(pendingPick()).toBeNull();
  });
});

describe("the Connection setting", () => {
  it("connects with a wrapping token and forgets the token", async () => {
    const post = vi.fn(async () => ({
      data: {
        configured: true,
        connected: true,
        since: "2026-11-09T09:00:00.000Z",
        by: "admin-1",
        problem: null,
        login: { step: "login", ok: true, message: "logged in" },
      },
    }));
    await setup({ post: post as never });
    rendered!.renderSettingsComponent("connection", {
      pluginId: "openbao-secrets",
      values: {},
      setValue: vi.fn(),
      running: true,
    });
    const input = (await screen.findByPlaceholderText(
      locales.connection.tokenPlaceholder,
    )) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "hvs.wrapping-token" } });
    fireEvent.click(screen.getByText(locales.connection.connect));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/admin/connect", {
        wrappingToken: "hvs.wrapping-token",
      }),
    );
    await waitFor(() => expect(input.value).toBe(""));
    expect(await screen.findByText(/Connected since/)).toBeTruthy();
  });
});
