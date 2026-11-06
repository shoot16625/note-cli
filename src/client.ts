import { cookieHeader, loadSession, type Session } from "./session.ts";

export const NOTE_ORIGIN = "https://note.com";
export const EDITOR_ORIGIN = "https://editor.note.com";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export class CliError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly detail?: unknown;
  constructor(code: string, message: string, opts: { status?: number; detail?: unknown } = {}) {
    super(message);
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  /** Send session cookies. "required" fails fast when not logged in. */
  auth?: "none" | "optional" | "required";
  /** Mimic requests from the editor (needed for draft APIs). */
  editor?: boolean;
}

export class NoteClient {
  private session: Session | null | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Minimum delay between requests, to stay polite with an unofficial API. */
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(opts: { session?: Session | null; fetchImpl?: typeof fetch; minIntervalMs?: number } = {}) {
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env.NOTE_CLI_INTERVAL_MS ?? 500);
  }

  async getSession(): Promise<Session | null> {
    if (this.session === undefined) this.session = await loadSession();
    return this.session;
  }

  async request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const url = new URL(path.startsWith("http") ? path : `${NOTE_ORIGIN}/api${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };

    const authMode = opts.auth ?? "none";
    if (authMode !== "none") {
      const session = await this.getSession();
      if (!session || !session.cookies._note_session_v5) {
        if (authMode === "required") {
          throw new CliError(
            "NOT_LOGGED_IN",
            "Not logged in. Run `note-cli auth login` (or `note-cli auth import`).",
          );
        }
      } else {
        headers.Cookie = cookieHeader(session.cookies);
        const xsrf = session.cookies["XSRF-TOKEN"];
        if (xsrf) headers["X-XSRF-TOKEN"] = safeDecode(xsrf);
      }
    }

    if (method !== "GET") {
      const origin = opts.editor ? EDITOR_ORIGIN : NOTE_ORIGIN;
      headers.Origin = origin;
      headers.Referer = `${origin}/`;
      headers["X-Requested-With"] = "XMLHttpRequest";
    }

    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }

    await this.throttle();
    if (process.env.NOTE_CLI_DEBUG) console.error(`[note-cli] ${method} ${url}`);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body });
    } catch (e) {
      throw new CliError("NETWORK_ERROR", `Request failed: ${(e as Error).message}`);
    }

    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep as text
      }
    }

    if (!res.ok) {
      const code =
        res.status === 401 || res.status === 403
          ? "AUTH_ERROR"
          : res.status === 404
            ? "NOT_FOUND"
            : res.status === 429
              ? "RATE_LIMITED"
              : "API_ERROR";
      const hint =
        code === "AUTH_ERROR" ? " Session may be expired; run `note-cli auth login` again." : "";
      const apiMessage = (data as any)?.error?.message;
      const suffix = typeof apiMessage === "string" ? ` ${apiMessage}` : "";
      throw new CliError(code, `${method} ${url.pathname} -> HTTP ${res.status}.${suffix}${hint}`, {
        status: res.status,
        detail: typeof data === "string" ? data.slice(0, 500) : data,
      });
    }
    return data as T;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
