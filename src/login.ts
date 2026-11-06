import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./client.ts";

/** Common install locations of Chromium-based browsers, in preference order. */
function browserCandidates(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
    case "win32": {
      const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
      return roots.flatMap((r) => [
        join(r as string, "Google/Chrome/Application/chrome.exe"),
        join(r as string, "Microsoft/Edge/Application/msedge.exe"),
      ]);
    }
    default:
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  }
}

export function findBrowser(explicit?: string): string {
  const path = explicit || process.env.NOTE_CLI_BROWSER || browserCandidates().find((p) => existsSync(p));
  if (!path || !existsSync(path)) {
    throw new CliError(
      "BROWSER_NOT_FOUND",
      "No Chrome/Edge/Chromium found. Pass --browser <path> (or set NOTE_CLI_BROWSER), or use `note-cli auth import`.",
    );
  }
  return path;
}

/** Minimal Chrome DevTools Protocol client over the browser-level WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForDevToolsPort(profileDir: string, proc: ChildProcess, timeoutMs = 20000): Promise<string> {
  const file = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new CliError("BROWSER_LAUNCH_FAILED", "Browser exited before it was ready.");
    try {
      const [port, path] = (await readFile(file, "utf8")).trim().split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // not written yet
    }
    await sleep(200);
  }
  throw new CliError("BROWSER_LAUNCH_FAILED", "Timed out waiting for the browser's DevTools port.");
}

/**
 * Open a fresh browser window on the note.com login page, let the user log in by hand
 * (email/password login requires reCAPTCHA since 2026-05), and return the note.com cookies
 * once `isLoggedIn` accepts them.
 */
export async function browserLogin(opts: {
  timeoutSec: number;
  browser?: string;
  isLoggedIn: (cookies: Record<string, string>) => Promise<boolean>;
}): Promise<Record<string, string>> {
  const executable = findBrowser(opts.browser);
  const profileDir = await mkdtemp(join(tmpdir(), "note-cli-login-"));
  const proc = spawn(
    executable,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "https://note.com/login",
    ],
    { stdio: "ignore" },
  );
  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.connect(await waitForDevToolsPort(profileDir, proc));
    console.error("Log in to note.com in the opened browser window. Waiting...");

    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new CliError("LOGIN_ABORTED", "The browser was closed before login completed.");

      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; url: string }> }>("Target.getTargets");
      const onLoginPage = targetInfos.some((t) => t.type === "page" && /note\.com\/login/.test(t.url));
      if (!onLoginPage) {
        const { cookies } = await cdp.send<{ cookies: Array<{ name: string; value: string; domain: string }> }>(
          "Storage.getCookies",
        );
        const map = Object.fromEntries(
          cookies.filter((c) => /(^|\.)note\.com$/.test(c.domain.replace(/^\./, ""))).map((c) => [c.name, c.value]),
        );
        if (map._note_session_v5 && (await opts.isLoggedIn(map))) return map;
      }
      await sleep(1500);
    }
    throw new CliError("LOGIN_TIMEOUT", `Login was not completed within ${opts.timeoutSec}s.`);
  } finally {
    cdp?.close();
    proc.kill();
    await sleep(300);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
