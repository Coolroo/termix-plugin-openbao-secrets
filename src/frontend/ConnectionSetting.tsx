import { useCallback, useEffect, useState } from "react";
import {
  useCurrentUser,
  usePluginApi,
  useTranslation,
  type SettingsComponentProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input, useConfirm } from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import {
  errorMessage,
  formatTime,
  type AdminStatus,
  type TestStep,
} from "./types";

/**
 * The admin's Connection section in the plugin's settings: Connect with a
 * response-wrapped token, Disconnect, Test connection. The secret ID is
 * never shown; only since when and by whom OpenBao is connected.
 */
export function ConnectionSetting({ running }: SettingsComponentProps) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const me = useCurrentUser();
  const confirm = useConfirm();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<TestStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<AdminStatus>("/admin/connection");
      setStatus(data);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, t("errors.load")));
    }
  }, [api, t]);

  useEffect(() => {
    if (running) void load();
  }, [load, running]);

  async function connect() {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSteps(null);
    try {
      const { data } = await api.post<AdminStatus & { login: TestStep }>(
        "/admin/connect",
        { wrappingToken: token.trim() },
      );
      setStatus(data);
      setSteps([data.login]);
      if (data.login.ok) toast.success(t("connection.connected"));
      else toast.error(t("connection.loginFailed"));
    } catch (failure) {
      setError(errorMessage(failure, t("errors.connect")));
    } finally {
      // A wrapping token works once: never keep it.
      setToken("");
      setBusy(false);
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: t("connection.disconnectTitle"),
      description: t("connection.disconnectDescription"),
      confirmLabel: t("connection.disconnect"),
    });
    if (!ok) return;
    setBusy(true);
    setSteps(null);
    try {
      const { data } = await api.post<AdminStatus>("/admin/disconnect");
      setStatus(data);
    } catch (failure) {
      setError(errorMessage(failure, t("errors.connect")));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<{ ok: boolean; steps: TestStep[] }>(
        "/admin/test",
      );
      setSteps(data.steps);
    } catch (failure) {
      setError(errorMessage(failure, t("errors.test")));
    } finally {
      setBusy(false);
    }
  }

  const by = !status?.by
    ? ""
    : status.by === me?.userId
      ? t("list.you")
      : status.by;

  return (
    <div className="flex flex-col gap-3 py-2" data-connection="true">
      <div>
        <div className="text-sm font-medium">{t("connection.title")}</div>
        <p className="text-xs text-muted-foreground">
          {t("connection.description")}
        </p>
      </div>
      {!running ? (
        <p className="text-xs text-muted-foreground">
          {t("connection.notRunning")}
        </p>
      ) : (
        <>
          <p className="text-xs" data-connection-status="true">
            {status?.connected
              ? t("connection.since", {
                  time: formatTime(status.since),
                  who: by,
                })
              : t("connection.none")}
          </p>
          {status && !status.configured && status.problem ? (
            <p className="text-xs text-muted-foreground">
              {t("connection.saveFirst", { problem: status.problem })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              placeholder={t("connection.tokenPlaceholder")}
              aria-label={t("connection.token")}
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              className="h-8 max-w-sm font-mono text-xs"
            />
            <Button
              size="sm"
              onClick={() => void connect()}
              disabled={busy || !token.trim()}
            >
              {t("connection.connect")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void test()}
              disabled={busy}
            >
              {t("connection.test")}
            </Button>
            {status?.connected ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void disconnect()}
                disabled={busy}
              >
                {t("connection.disconnect")}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("connection.tokenHint")}
          </p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {steps ? (
            <ul className="flex flex-col gap-1 text-xs" data-test-steps="true">
              {steps.map((step) => (
                <li
                  key={step.step}
                  className={step.ok ? "" : "text-destructive"}
                  data-step={step.step}
                  data-ok={step.ok ? "true" : "false"}
                >
                  {t(step.ok ? "connection.stepOk" : "connection.stepFailed", {
                    step: t(`connection.steps.${step.step}`),
                    message: step.message,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
