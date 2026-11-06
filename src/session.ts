import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Session {
  /** note.com cookies, name -> value */
  cookies: Record<string, string>;
  urlname?: string;
  userId?: number;
  savedAt: string;
}

export function configDir(): string {
  if (process.env.NOTE_CLI_HOME) return process.env.NOTE_CLI_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "note-cli");
}

export function sessionPath(): string {
  return join(configDir(), "session.json");
}

/** Parse a `Cookie:` header style string ("a=1; b=2") into a map. */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.replace(/^cookie:\s*/i, "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Load the session. `NOTE_COOKIE` (a raw Cookie header) overrides the saved file,
 * which is handy for CI or one-off runs.
 */
export async function loadSession(): Promise<Session | null> {
  if (process.env.NOTE_COOKIE) {
    return { cookies: parseCookieHeader(process.env.NOTE_COOKIE), savedAt: "env" };
  }
  try {
    const raw = await readFile(sessionPath(), "utf8");
    return JSON.parse(raw) as Session;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function saveSession(session: Session): Promise<string> {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function clearSession(): Promise<boolean> {
  try {
    await rm(sessionPath());
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
