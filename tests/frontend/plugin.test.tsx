import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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

  it("adds a secret through the masked field, which shows only dots", async () => {
    const fakes = await setup();
    rendered!.renderTab(TAB_ID, { isVisible: true });
    await screen.findByText("wifi");
    fireEvent.click(screen.getAllByText(locales.list.add)[0]);
    const name = await screen.findByPlaceholderText(
      locales.form.namePlaceholder,
    );
    fireEvent.change(name, { target: { value: "api/token" } });
    const field = document.querySelector(
      'textarea[data-masked="true"]',
    ) as HTMLTextAreaElement;
    expect(field).toBeTruthy();
    fireEvent.change(field, { target: { value: "ab\ncd" } });
    expect(field.value).toBe("••\n••");
    expect(document.body.innerHTML).not.toContain("ab\ncd");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.getAttribute("autocomplete")).toBe("off");
    fireEvent.click(screen.getByText(locales.form.add));
    await waitFor(() =>
      expect(fakes.post).toHaveBeenCalledWith("/secrets", {
        section: "user",
        name: "api/token",
        value: "ab\ncd",
      }),
    );
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
    await waitFor(() =>
      expect(sendToActive).toHaveBeenCalledWith(VALUE, { run: false }),
    );
    expect(sendToSession).not.toHaveBeenCalled();
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
