import type { ComponentType } from "react";
import {
  useTranslation,
  type KeybindingRunContext,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import { ConnectionSetting } from "./ConnectionSetting";
import { SecretPicker } from "./Picker";
import { createSecretsTab, SecretsIcon } from "./SecretsTab";
import {
  listSessions,
  requestPick,
  resolveTarget,
  type HostHint,
} from "./terminal";

export const TAB_ID = "openbao-secrets";
/** The terminal toolbar button, the keybinding and the palette entry. */
export const TYPE_ACTION = "openbao-secrets.typeSecret";
/** The picker in the terminal's side panel ("terminal.sidePanel"). */
export const PICKER_PANEL = "openbao-secrets.picker";

/** What SSH Terminal 1.3.0 hands a "terminal.toolbar" action. */
interface TerminalSlotApi {
  host?: HostHint;
  sessionId?: () => string | null;
  openSidePanel?: (panelId: string, props?: Record<string, unknown>) => void;
}

/** What SSH Terminal 1.3.0 renders a "terminal.sidePanel" component with. */
interface SidePanelProps {
  host?: HostHint;
  hostId?: number;
  hostLabel?: string;
  panelProps?: { auditSessionId?: string | null };
  onClose?: () => void;
}

function createSidePanel(app: TermixApp) {
  return function SecretsSidePanel(props: SidePanelProps) {
    const { t } = useTranslation();
    return (
      <div
        className="flex h-full min-h-0 w-72 flex-col gap-2 border-l border-border bg-background p-3"
        data-side-panel="true"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("picker.title")}</span>
          <Button size="sm" variant="ghost" onClick={() => props.onClose?.()}>
            {t("picker.close")}
          </Button>
        </div>
        <SecretPicker
          app={app}
          resolveTarget={async () =>
            resolveTarget(
              await listSessions(app.invokeAction),
              { ...props.host, id: props.hostId ?? props.host?.id ?? null },
              props.panelProps?.auditSessionId ?? null,
            )
          }
          onPicked={(_target, typed) => {
            if (typed) props.onClose?.();
          }}
        />
      </div>
    );
  };
}

export function activate(app: TermixApp): void {
  app.registerRailItem({
    id: TAB_ID,
    icon: SecretsIcon,
    titleKey: "tab.title",
    kind: "tab",
    permission: "use",
  });
  app.registerTab(TAB_ID, createSecretsTab(app), {
    icon: SecretsIcon,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
  });

  // The admin's Connection section in the plugin's settings (manifest
  // contributes.settings.admin, the "connection" custom field).
  app.registerSettingsComponent("connection", ConnectionSetting);

  // Opens the Secrets tab in pick mode on the terminal the user is in: for
  // the keybinding and the palette, which give no side panel to draw in.
  const pickFromTab = async (hint: HostHint | null) => {
    requestPick(resolveTarget(await listSessions(app.invokeAction), hint));
    app.tabs.openSingletonTab(TAB_ID);
  };

  // SSH Terminal's toolbar button: opens the picker beside that terminal.
  app.registerAction(
    TYPE_ACTION,
    ((terminal?: TerminalSlotApi) => {
      if (terminal?.openSidePanel) {
        terminal.openSidePanel(PICKER_PANEL, {
          auditSessionId: terminal.sessionId?.() ?? null,
        });
        return;
      }
      void pickFromTab(terminal?.host ?? null);
    }) as never,
    { permission: "use" },
  );
  app.registerSlotContribution("terminal.toolbar", {
    actionId: TYPE_ACTION,
    titleKey: "picker.title",
    icon: SecretsIcon,
    kind: "button",
  });

  // The side panel. Its own action carries the permission the terminal
  // checks before it lists the panel, and opens it from the dock button.
  app.registerAction(
    PICKER_PANEL,
    ((terminal?: TerminalSlotApi) =>
      terminal?.openSidePanel?.(PICKER_PANEL, {})) as never,
    { permission: "use" },
  );
  app.registerSlotContribution("terminal.sidePanel", {
    actionId: PICKER_PANEL,
    titleKey: "picker.title",
    icon: SecretsIcon,
    kind: "component",
    component: createSidePanel(app) as unknown as ComponentType<
      Record<string, unknown>
    >,
  });

  // Appearance > Keybindings: bind a key to "Type a secret" in a terminal.
  app.registerKeybindingAction({
    id: TYPE_ACTION,
    titleKey: "picker.title",
    scope: "session",
    run: (_action, context: KeybindingRunContext) => {
      void pickFromTab(context.host ?? null);
    },
  });

  // The command palette. Only offered to people who may use secrets.
  let allowed = false;
  void app.hasPermission("use").then((value) => {
    allowed = value;
  });
  app.registerPaletteEntry({
    id: TYPE_ACTION,
    titleKey: "picker.title",
    icon: SecretsIcon,
    keywords: ["secret", "password", "openbao", "vault"],
    scope: "global",
    when: () => allowed,
    run: () => {
      void pickFromTab(null);
    },
  });
}
