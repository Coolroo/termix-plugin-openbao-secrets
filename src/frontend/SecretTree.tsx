import { useState, type ReactNode } from "react";
import { ListRowFolder } from "@termix-ssh/plugin-sdk/ui";
import type { SecretEntry } from "./types";

interface Folder {
  folders: Map<string, Folder>;
  secrets: SecretEntry[];
}

/** Names split on "/" into folders, each sorted by name. */
export function buildTree(entries: SecretEntry[]): Folder {
  const root: Folder = { folders: new Map(), secrets: [] };
  for (const entry of entries) {
    const parts = entry.name.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { folders: new Map(), secrets: [] };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.secrets.push(entry);
  }
  return root;
}

function count(folder: Folder): number {
  let total = folder.secrets.length;
  for (const child of folder.folders.values()) total += count(child);
  return total;
}

/** Whether `entry` matches a search: any part of its name or note. */
export function matchesSearch(entry: SecretEntry, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return (
    entry.name.toLowerCase().includes(query) ||
    (entry.note ?? "").toLowerCase().includes(query)
  );
}

/**
 * A list of secrets with folders by "/". While a search is typed every
 * folder is open, so each match shows.
 */
export function SecretTree({
  entries,
  search,
  row,
}: {
  entries: SecretEntry[];
  search: string;
  /** One secret's row; `leaf` is the last part of its name. */
  row: (entry: SecretEntry, leaf: string, stripe: number) => ReactNode;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const searching = search.trim() !== "";
  const tree = buildTree(
    entries.filter((entry) => matchesSearch(entry, search)),
  );
  let stripe = 0;

  function render(folder: Folder, path: string): ReactNode[] {
    const out: ReactNode[] = [];
    for (const name of [...folder.folders.keys()].sort()) {
      const child = folder.folders.get(name)!;
      const key = path ? `${path}/${name}` : name;
      const isOpen = searching || open[key] === true;
      out.push(
        <ListRowFolder
          key={`folder:${key}`}
          name={name}
          count={count(child)}
          open={isOpen}
          stripe={stripe++}
          onToggle={() =>
            setOpen((state) => ({ ...state, [key]: !state[key] }))
          }
        >
          {isOpen ? render(child, key) : null}
        </ListRowFolder>,
      );
    }
    const secrets = [...folder.secrets].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of secrets) {
      const leaf = entry.name.split("/").pop() ?? entry.name;
      out.push(
        <div key={`secret:${entry.name}`}>{row(entry, leaf, stripe++)}</div>,
      );
    }
    return out;
  }

  return <>{render(tree, "")}</>;
}
