import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  useCurrentUser,
  usePluginApi,
  useShell,
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  BackButton,
  EmptyState,
  FormFooter,
  GroupHeading,
  InlineView,
  ListRow,
  ListRowAction,
  PanelList,
  PanelSearch,
  PanelShell,
  SelectField,
  TextField,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { isValidName, MAX_NOTE_LENGTH } from "../shared/names";
import { SecretValueField } from "./SecretValueField";
import { SecretPicker } from "./Picker";
import { SecretTree } from "./SecretTree";
import { clearPick, onPickChange, pendingPick } from "./terminal";
import {
  errorMessage,
  formatTime,
  isNotConnected,
  type SecretEntry,
  type SecretLists,
  type Section,
  type Status,
} from "./types";

export function SecretsIcon(props: { className?: string }) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

type Editing =
  | { mode: "add"; section: Section }
  | { mode: "replace"; section: Section; name: string };

function SecretForm({
  editing,
  canManageShared,
  onDone,
}: {
  editing: Editing;
  canManageShared: boolean;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const [section, setSection] = useState<Section>(editing.section);
  const [name, setName] = useState(
    editing.mode === "replace" ? editing.name : "",
  );
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError =
    editing.mode === "add" && name !== "" && !isValidName(name)
      ? t("form.nameRule")
      : undefined;
  const noteError =
    note.length > MAX_NOTE_LENGTH
      ? t("form.noteRule", { max: MAX_NOTE_LENGTH })
      : undefined;
  const ready = value !== "" && isValidName(name) && !noteError && !saving;

  async function save() {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      if (editing.mode === "add") {
        await api.post("/secrets", {
          section,
          name,
          value,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        toast.success(t("form.added", { name }));
      } else {
        await api.put("/secrets", { section, name, value });
        toast.success(t("form.replaced", { name }));
      }
      setValue("");
      onDone(true);
    } catch (failure) {
      setError(errorMessage(failure, t("errors.save")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) {
          setValue("");
          onDone(false);
        }
      }}
      title={
        editing.mode === "add"
          ? t("form.addTitle")
          : t("form.replaceTitle", { name: editing.name })
      }
      footer={
        <FormFooter
          onCancel={() => {
            setValue("");
            onDone(false);
          }}
          onSave={() => void save()}
          saveLabel={editing.mode === "add" ? t("form.add") : t("form.replace")}
          saving={saving}
          disabled={!ready}
          status={error ?? undefined}
        />
      }
    >
      <div className="flex flex-col gap-3 p-3" data-form={editing.mode}>
        {editing.mode === "add" && canManageShared ? (
          <SelectField<Section>
            label={t("form.section")}
            value={section}
            onChange={setSection}
            options={[
              { value: "user", label: t("list.yours") },
              { value: "shared", label: t("list.shared") },
            ]}
          />
        ) : null}
        <TextField
          label={t("form.name")}
          value={name}
          onChange={setName}
          placeholder={t("form.namePlaceholder")}
          hint={t("form.nameHint")}
          error={nameError}
          disabled={editing.mode === "replace"}
          mono
        />
        <div className="flex flex-col gap-1">
          <label
            htmlFor="openbao-secrets-value"
            className="text-xs font-medium"
          >
            {t("form.value")}
          </label>
          <SecretValueField
            id="openbao-secrets-value"
            value={value}
            onChange={setValue}
            ariaLabel={t("form.value")}
          />
          <p className="text-xs text-muted-foreground">{t("form.valueHint")}</p>
        </div>
        {editing.mode === "add" ? (
          <TextField
            label={t("form.note")}
            value={note}
            onChange={setNote}
            hint={t("form.noteHint")}
            error={noteError}
          />
        ) : null}
      </div>
    </InlineView>
  );
}

export function createSecretsTab(app: TermixApp) {
  return function SecretsTab(_props: TabProps) {
    const { t } = useTranslation();
    const api = usePluginApi();
    const shell = useShell();
    const me = useCurrentUser();
    const confirm = useConfirm();
    const [status, setStatus] = useState<Status | null>(null);
    const [lists, setLists] = useState<SecretLists | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [editing, setEditing] = useState<Editing | null>(null);
    const pick = useSyncExternalStore(onPickChange, pendingPick, pendingPick);

    const load = useCallback(async () => {
      try {
        const { data } = await api.get<Status>("/status");
        setStatus(data);
        if (!data.connected || !data.configured) {
          setLists(null);
          return;
        }
        const listed = await api.get<SecretLists>("/secrets");
        setLists(listed.data);
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

    async function remove(section: Section, entry: SecretEntry) {
      const ok = await confirm({
        title: t("delete.title", { name: entry.name }),
        description: t("delete.description"),
        confirmLabel: t("delete.confirm"),
      });
      if (!ok) return;
      try {
        await api.delete(
          `/secrets?section=${section}&name=${encodeURIComponent(entry.name)}`,
        );
        toast.success(t("delete.done", { name: entry.name }));
        await load();
      } catch (error) {
        toast.error(errorMessage(error, t("errors.delete")));
      }
    }

    const who = (id: string | null) =>
      !id ? "" : id === me?.userId ? t("list.you") : id;

    const meta = (entry: SecretEntry) => {
      const parts = [
        t("list.updated", {
          time: formatTime(entry.updatedAt ?? entry.createdAt),
        }),
      ];
      if (entry.createdBy) {
        parts.push(t("list.createdBy", { who: who(entry.createdBy) }));
      }
      if (entry.expiresAt) {
        parts.push(t("list.expires", { time: formatTime(entry.expiresAt) }));
      }
      if (entry.note) parts.push(entry.note);
      return parts.join(" · ");
    };

    const section = (key: Section, title: string) => {
      const entries = lists?.[key] ?? [];
      const mayWrite = key === "user" || status?.canManageShared === true;
      return (
        <div data-section={key}>
          <GroupHeading title={title} count={entries.length} />
          {entries.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {key === "user" ? t("list.emptyYours") : t("list.emptyShared")}
            </p>
          ) : (
            <SecretTree
              entries={entries}
              search={search}
              row={(entry, leaf, stripe) => (
                <ListRow
                  title={leaf}
                  meta={meta(entry)}
                  stripe={stripe}
                  data-secret={`${key}/${entry.name}`}
                  actions={
                    mayWrite ? (
                      <>
                        <ListRowAction
                          label={t("list.replace")}
                          onClick={() =>
                            setEditing({
                              mode: "replace",
                              section: key,
                              name: entry.name,
                            })
                          }
                        >
                          {t("list.replace")}
                        </ListRowAction>
                        <ListRowAction
                          label={t("list.delete")}
                          tone="destructive"
                          onClick={() => void remove(key, entry)}
                        >
                          {t("list.delete")}
                        </ListRowAction>
                      </>
                    ) : undefined
                  }
                />
              )}
            />
          )}
        </div>
      );
    };

    const connected = status?.connected === true && status.configured;

    if (pick) {
      return (
        <PanelShell
          icon={<SecretsIcon className="size-4" />}
          title={t("picker.title")}
          leading={
            <BackButton
              onClick={() => clearPick()}
              label={t("picker.cancel")}
            />
          }
        >
          <div className="p-3" data-pick-mode="true">
            {pick.label ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {t("picker.into", { terminal: pick.label })}
              </p>
            ) : null}
            <SecretPicker
              app={app}
              resolveTarget={async () => pick}
              onPicked={(target, typed) => {
                clearPick();
                if (typed && target.sessionId) {
                  shell?.tabs.setActive(target.sessionId);
                }
              }}
            />
          </div>
        </PanelShell>
      );
    }

    return (
      <PanelShell
        icon={<SecretsIcon className="size-4" />}
        title={t("tab.title")}
        docs={app.docs.url}
        toolbar={
          connected ? (
            <div className="flex w-full items-center gap-2">
              <PanelSearch
                value={search}
                onChange={setSearch}
                placeholder={t("list.search")}
              />
              <AddButton
                label={t("list.add")}
                onClick={() => setEditing({ mode: "add", section: "user" })}
              />
            </div>
          ) : undefined
        }
      >
        {!status ? null : !connected ? (
          <div data-status="not-connected">
            <EmptyState
              icon={SecretsIcon as never}
              title={t("status.notConnected")}
              hint={status.isAdmin ? t("status.adminHint") : undefined}
            />
          </div>
        ) : problem ? (
          <p className="p-3 text-xs text-destructive">{problem}</p>
        ) : (
          <PanelList>
            {section("user", t("list.yours"))}
            {section("shared", t("list.shared"))}
          </PanelList>
        )}
        {editing ? (
          <SecretForm
            editing={editing}
            canManageShared={status?.canManageShared === true}
            onDone={(saved) => {
              setEditing(null);
              if (saved) void load();
            }}
          />
        ) : null}
      </PanelShell>
    );
  };
}
