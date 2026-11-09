import { useCallback, useEffect, useState } from "react";
import {
  usePluginApi,
  useTranslation,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Alert,
  AlertDescription,
  GroupHeading,
  ListRow,
  PanelList,
  PanelSearch,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { SecretTree } from "./SecretTree";
import { typeInto, type PickTarget } from "./terminal";
import {
  errorMessage,
  isNotConnected,
  type SecretLists,
  type Section,
} from "./types";

/**
 * Lists your and the shared secret names and types the picked one at the
 * terminal's cursor, without Enter. The caution shows every time (S6).
 *
 * The value comes from POST /type, goes straight to the terminal and is
 * dropped: it is never put in state, rendered, logged or stored.
 */
export function SecretPicker({
  app,
  resolveTarget,
  onPicked,
}: {
  app: Pick<TermixApp, "invokeAction">;
  /** The terminal to type into, found when the person picks. */
  resolveTarget: () => Promise<PickTarget>;
  /** After a secret was typed (or could not be). */
  onPicked?: (target: PickTarget, typed: boolean) => void;
}) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const [lists, setLists] = useState<SecretLists | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<SecretLists>("/secrets");
      setLists(data);
      setProblem(null);
    } catch (error) {
      setLists(null);
      setProblem(
        isNotConnected(error)
          ? t("status.notConnected")
          : errorMessage(error, t("errors.load")),
      );
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pick(section: Section, name: string) {
    if (busy) return;
    setBusy(true);
    try {
      const target = await resolveTarget();
      let typed = false;
      try {
        const { data } = await api.post<{ value: string }>("/type", {
          section,
          name,
          sessionId: target.auditSessionId ?? target.sessionId ?? undefined,
          hostId: target.hostId ?? undefined,
        });
        typed = await typeInto(app.invokeAction, target, data.value);
        // Drop it: nothing keeps the answer once it is typed.
        (data as { value: string }).value = "";
      } catch (error) {
        toast.error(errorMessage(error, t("picker.failed")));
        onPicked?.(target, false);
        return;
      }
      if (typed) toast.success(t("picker.typed", { name }));
      else toast.error(t("picker.noTerminal"));
      onPicked?.(target, typed);
    } finally {
      setBusy(false);
    }
  }

  const section = (key: Section, title: string) => {
    const entries = lists?.[key] ?? [];
    if (entries.length === 0) return null;
    return (
      <div data-section={key}>
        <GroupHeading title={title} count={entries.length} />
        <SecretTree
          entries={entries}
          search={search}
          row={(entry, leaf, stripe) => (
            <ListRow
              title={leaf}
              meta={entry.note ?? undefined}
              stripe={stripe}
              dimmed={busy}
              data-secret={`${key}/${entry.name}`}
              onClick={() => void pick(key, entry.name)}
            />
          )}
        />
      </div>
    );
  };

  const empty = lists && lists.user.length === 0 && lists.shared.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Alert data-caution="true">
        <AlertDescription>{t("picker.caution")}</AlertDescription>
      </Alert>
      {problem ? (
        <p className="px-1 text-xs text-muted-foreground">{problem}</p>
      ) : (
        <>
          <PanelSearch
            value={search}
            onChange={setSearch}
            placeholder={t("list.search")}
            autoFocus
          />
          <PanelList empty={empty ? t("picker.empty") : undefined}>
            {section("user", t("list.yours"))}
            {section("shared", t("list.shared"))}
          </PanelList>
        </>
      )}
    </div>
  );
}
