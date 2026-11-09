/**
 * Finding the terminal a secret goes to, and typing it there, through the
 * SSH Terminal plugin's actions:
 *
 * - terminal.listSessions: the open sessions, each with the tab's id (the
 *   registry id), its host and whether it is visible and connected.
 * - terminal.sendToSession(id, text, { run: false }): types into one
 *   session without pressing Enter.
 * - terminal.sendToActive(text, { run: false }): the same, into the session
 *   the user worked in last.
 *
 * The id terminal.sendToSession takes is the tab's id, not the backend SSH
 * session id the toolbar's TerminalSlotApi.sessionId() gives, so the target
 * is found by host among the visible sessions.
 */

export interface TerminalSession {
  id: string;
  hostId?: number | string | null;
  hostName?: string;
  label?: string;
  ip?: string;
  username?: string;
  port?: number;
  connected?: boolean;
  visible?: boolean;
}

/** What the terminal says about its host, in any of the shapes it uses. */
export interface HostHint {
  id?: number | string | null;
  ip?: string;
  username?: string;
  name?: string;
  port?: number | string;
}

/** Where a picked secret goes. */
export interface PickTarget {
  /** The tab's registry id, or null for "the active session". */
  sessionId: string | null;
  hostId: number | null;
  /** The backend SSH session id, for the audit line only. */
  auditSessionId: string | null;
  /** What the picker names the terminal by. */
  label: string | null;
}

export type InvokeAction = (id: string, ...args: unknown[]) => Promise<unknown>;

function hostNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function matches(session: TerminalSession, hint: HostHint): boolean {
  const id = hostNumber(hint.id);
  if (id !== null) return hostNumber(session.hostId) === id;
  if (!hint.ip) return false;
  return (
    session.ip === hint.ip &&
    (!hint.username || session.username === hint.username) &&
    (hint.port === undefined ||
      session.port === undefined ||
      Number(session.port) === Number(hint.port))
  );
}

/**
 * The session to type into: the one visible, connected session on the
 * host, else the one visible, connected session at all. When that is not
 * one session (a split with two terminals on the host, say), the target is
 * the active session.
 */
export function resolveTarget(
  sessions: TerminalSession[],
  hint: HostHint | null,
  auditSessionId: string | null = null,
): PickTarget {
  const open = sessions.filter(
    (session) => session.visible === true && session.connected !== false,
  );
  const onHost = hint ? open.filter((session) => matches(session, hint)) : [];
  const chosen =
    onHost.length === 1 ? onHost[0] : open.length === 1 ? open[0] : null;
  return {
    sessionId: chosen?.id ?? null,
    hostId: hostNumber(chosen?.hostId) ?? hostNumber(hint?.id),
    auditSessionId: auditSessionId ?? chosen?.id ?? null,
    label: chosen?.label ?? chosen?.hostName ?? hint?.name ?? null,
  };
}

export async function listSessions(
  invoke: InvokeAction,
): Promise<TerminalSession[]> {
  try {
    const sessions = await invoke("terminal.listSessions");
    return Array.isArray(sessions) ? (sessions as TerminalSession[]) : [];
  } catch {
    // SSH Terminal is not installed or not running.
    return [];
  }
}

/**
 * Types the value at the cursor, never pressing Enter. True when the
 * terminal took it.
 */
export async function typeInto(
  invoke: InvokeAction,
  target: PickTarget,
  value: string,
): Promise<boolean> {
  try {
    const sent = target.sessionId
      ? await invoke("terminal.sendToSession", target.sessionId, value, {
          run: false,
        })
      : await invoke("terminal.sendToActive", value, { run: false });
    return sent === true;
  } catch {
    return false;
  }
}

/**
 * A pick asked for from outside the Secrets tab (a keybinding, the command
 * palette): the tab opens in pick mode on it. Kept in memory only, and
 * holding no value.
 */
let pending: PickTarget | null = null;
const listeners = new Set<() => void>();

export function requestPick(target: PickTarget): void {
  pending = target;
  for (const listener of [...listeners]) listener();
}

export function pendingPick(): PickTarget | null {
  return pending;
}

export function clearPick(): void {
  pending = null;
  for (const listener of [...listeners]) listener();
}

export function onPickChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
