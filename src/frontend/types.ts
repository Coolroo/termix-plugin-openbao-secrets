/** What the routes answer with. A secret's value is never among them. */

export type Section = "user" | "shared";

export interface SecretEntry {
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  expiresAt: string | null;
  note: string | null;
}

export interface SecretLists {
  user: SecretEntry[];
  shared: SecretEntry[];
}

export interface Status {
  configured: boolean;
  connected: boolean;
  since: string | null;
  canManageShared: boolean;
  isAdmin: boolean;
}

export interface AdminStatus {
  configured: boolean;
  connected: boolean;
  since: string | null;
  by: string | null;
  problem: string | null;
}

export interface TestStep {
  step: string;
  ok: boolean;
  message: string;
}

/** The route's own message from an error, or the fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data;
  return typeof data?.error === "string" && data.error ? data.error : fallback;
}

/** Whether a request failed because OpenBao is not connected. */
export function isNotConnected(error: unknown): boolean {
  return (
    (error as { response?: { status?: number } })?.response?.status === 409
  );
}

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString();
}
