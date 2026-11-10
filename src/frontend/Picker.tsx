import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  usePluginApi,
  useTranslation,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Alert,
  AlertDescription,
  Button,
  GroupHeading,
  ListRow,
  PanelList,
  PanelSearch,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import {
  isShellVariable,
  isValidVariableName,
  MAX_VARIABLE_LENGTH,
  variableNameFor,
  variableValueProblem,
} from "../shared/names";
import { SecretTree } from "./SecretTree";
import { putInVariable, typeInto, type PickTarget } from "./terminal";
import {
  errorMessage,
  isNotConnected,
  type SecretLists,
  type Section,
} from "./types";

interface Chosen {
  section: Section;
  name: string;
}

/**
 * Lists your and the shared secret names. For the chosen one it offers
 * two things:
 *
 * - **Type at the cursor**: types the value where the cursor is, without
 *   Enter, for a password prompt. The caution shows every time (S6).
 * - **Put in a variable**: types ` IFS= read -rs NAME`, Enter, the value
 *   and Enter, so the value lands in a shell variable without showing on
 *   screen or going into history. Its own caution shows every time.
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
  const [chosen, setChosen] = useState<Chosen | null>(null);
  /** The variable name, while "Put in a variable" asks for it. */
  const [variable, setVariable] = useState<string | null>(null);

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

  function choose(next: Chosen | null) {
    setChosen(next);
    setVariable(null);
  }

  /** Why the variable name is refused, or null when it is good. */
  function variableError(name: string): string | null {
    if (isValidVariableName(name)) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && isShellVariable(name)) {
      return t("picker.variableShell", { variable: name });
    }
    return t("picker.variableRule", { max: MAX_VARIABLE_LENGTH });
  }

  async function typeAtCursor({ section, name }: Chosen) {
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

  async function putInShellVariable({ section, name }: Chosen, to: string) {
    if (busy || variableError(to) !== null) return;
    setBusy(true);
    try {
      const target = await resolveTarget();
      let put = false;
      try {
        const { data } = await api.post<{ value: string }>("/type", {
          section,
          name,
          sessionId: target.auditSessionId ?? target.sessionId ?? undefined,
          hostId: target.hostId ?? undefined,
          mode: "variable",
          variable: to,
        });
        // The server refuses these too. A second check here means a line
        // break can never end `read` early and run the rest as a command.
        const unfit = variableValueProblem(data.value) !== null;
        if (!unfit) {
          put = await putInVariable(app.invokeAction, target, to, data.value);
        }
        // Drop it: nothing keeps the answer once it is typed.
        (data as { value: string }).value = "";
        if (unfit) {
          toast.error(t("picker.variableUnfit"));
          onPicked?.(target, false);
          return;
        }
      } catch (error) {
        toast.error(errorMessage(error, t("picker.failed")));
        onPicked?.(target, false);
        return;
      }
      if (put) toast.success(t("picker.put", { name, variable: to }));
      else toast.error(t("picker.noTerminal"));
      onPicked?.(target, put);
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
              onClick={() => choose({ section: key, name: entry.name })}
            />
          )}
        />
      </div>
    );
  };

  const empty = lists && lists.user.length === 0 && lists.shared.length === 0;

  const choice = (picked: Chosen) => {
    if (variable === null) {
      return (
        <div className="flex flex-col gap-2" data-choice="true">
          <Button
            data-action="cursor"
            disabled={busy}
            onClick={() => void typeAtCursor(picked)}
          >
            {t("picker.typeAtCursor")}
          </Button>
          <Button
            variant="outline"
            data-action="variable"
            disabled={busy}
            onClick={() => setVariable(variableNameFor(picked.name))}
          >
            {t("picker.putInVariable")}
          </Button>
          <Button variant="ghost" onClick={() => choose(null)}>
            {t("picker.back")}
          </Button>
        </div>
      );
    }
    const error = variableError(variable);
    const submit = (event: FormEvent) => {
      event.preventDefault();
      void putInShellVariable(picked, variable);
    };
    return (
      <form
        className="flex flex-col gap-2"
        data-variable-form="true"
        onSubmit={submit}
      >
        <Alert data-caution="variable">
          <AlertDescription>{t("picker.variableCaution")}</AlertDescription>
        </Alert>
        <TextField
          label={t("picker.variableName")}
          value={variable}
          onChange={setVariable}
          hint={t("picker.variableHint")}
          error={error ?? undefined}
          mono
        />
        <Button type="submit" disabled={busy} data-action="put">
          {t("picker.putButton")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setVariable(null)}>
          {t("picker.back")}
        </Button>
      </form>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Alert data-caution="true">
        <AlertDescription>{t("picker.caution")}</AlertDescription>
      </Alert>
      {problem ? (
        <p className="px-1 text-xs text-muted-foreground">{problem}</p>
      ) : chosen ? (
        <div
          className="flex flex-col gap-2"
          data-chosen={`${chosen.section}/${chosen.name}`}
        >
          <p className="break-all px-1 text-sm font-medium">{chosen.name}</p>
          {choice(chosen)}
        </div>
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
