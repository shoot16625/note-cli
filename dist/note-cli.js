#!/usr/bin/env bun
// @bun

// src/cli.ts
import { readFile as readFile3 } from "fs/promises";
import { parseArgs } from "util";

// src/analyze.ts
function numberStats(values) {
  if (values.length === 0)
    return { count: 0, mean: 0, median: 0, p90: 0, max: 0, min: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    count: sorted.length,
    mean: round(mean),
    median: q(0.5),
    p90: q(0.9),
    max: sorted[sorted.length - 1],
    min: sorted[0]
  };
}
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var TITLE_FEATURES = {
  brackets: (t) => /[\u3010\u3011\[\]\u300C\u300D\u300E\u300F]/.test(t),
  number: (t) => /[0-9\uFF10-\uFF19]/.test(t),
  question: (t) => /[?\uFF1F]/.test(t),
  exclamation: (t) => /[!\uFF01]/.test(t),
  separator: (t) => /[\uFF5C|:\uFF1A/\uFF0F]/.test(t)
};
function analyzeNotes(notes, opts = {}) {
  const top = opts.top ?? 10;
  const likes = (ns) => ns.map((n) => n.likeCount);
  const paid = notes.filter((n) => n.isPaid);
  const free = notes.filter((n) => !n.isPaid);
  const buckets = [
    ["<20", 0, 20],
    ["20-29", 20, 30],
    ["30-39", 30, 40],
    ["40-49", 40, 50],
    ["50+", 50, Infinity]
  ];
  const titleLen = (n) => [...n.title].length;
  const withTime = notes.filter((n) => n.publishAt).map((n) => ({ n, jst: toJst(new Date(n.publishAt)) })).filter((x) => !Number.isNaN(x.jst.getTime()));
  const authorMap = new Map;
  for (const n of notes) {
    if (!n.author.urlname)
      continue;
    const a = authorMap.get(n.author.urlname) ?? { nickname: n.author.nickname, count: 0, totalLikes: 0 };
    a.count++;
    a.totalLikes += n.likeCount;
    authorMap.set(n.author.urlname, a);
  }
  const tagMap = new Map;
  for (const n of notes)
    for (const t of n.hashtags)
      tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
  const sortedTimes = withTime.map((x) => x.n.publishAt).sort();
  return {
    sampleSize: notes.length,
    likes: numberStats(likes(notes)),
    paid: {
      count: paid.length,
      ratio: notes.length ? round(paid.length / notes.length) : 0,
      price: numberStats(paid.map((n) => n.price)),
      likesOfPaid: numberStats(likes(paid)),
      likesOfFree: numberStats(likes(free))
    },
    titleLength: {
      stats: numberStats(notes.map(titleLen)),
      byBucket: buckets.map(([bucket, lo, hi]) => {
        const ns = notes.filter((n) => titleLen(n) >= lo && titleLen(n) < hi);
        return { bucket, count: ns.length, medianLikes: numberStats(likes(ns)).median };
      })
    },
    titleFeatures: Object.entries(TITLE_FEATURES).map(([feature, test]) => {
      const withF = notes.filter((n) => test(n.title));
      const without = notes.filter((n) => !test(n.title));
      return {
        feature,
        withCount: withF.length,
        medianLikesWith: numberStats(likes(withF)).median,
        medianLikesWithout: numberStats(likes(without)).median
      };
    }),
    publishTime: {
      byWeekday: WEEKDAYS.map((weekday, i) => {
        const ns = withTime.filter((x) => x.jst.getUTCDay() === i).map((x) => x.n);
        return { weekday, count: ns.length, medianLikes: numberStats(likes(ns)).median };
      }),
      byHour: Array.from({ length: 24 }, (_, hour) => {
        const ns = withTime.filter((x) => x.jst.getUTCHours() === hour).map((x) => x.n);
        return { hour, count: ns.length, medianLikes: numberStats(likes(ns)).median };
      }).filter((h) => h.count > 0),
      oldest: sortedTimes[0] ?? null,
      newest: sortedTimes[sortedTimes.length - 1] ?? null
    },
    topAuthors: [...authorMap.entries()].map(([urlname, a]) => ({ urlname, ...a })).sort((a, b) => b.count - a.count || b.totalLikes - a.totalLikes).slice(0, top),
    topHashtags: [...tagMap.entries()].map(([hashtag, count]) => ({ hashtag, count })).sort((a, b) => b.count - a.count).slice(0, top * 2),
    topNotes: [...notes].sort((a, b) => b.likeCount - a.likeCount).slice(0, top).map((n) => ({
      title: n.title,
      url: n.url,
      likeCount: n.likeCount,
      price: n.price,
      publishAt: n.publishAt,
      author: n.author.urlname
    }))
  };
}
function toJst(d) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000);
}
function round(v) {
  return Math.round(v * 100) / 100;
}

// src/session.ts
import { mkdir, readFile, rm, writeFile, chmod } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
function configDir() {
  if (process.env.NOTE_CLI_HOME)
    return process.env.NOTE_CLI_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "note-cli");
}
function sessionPath() {
  return join(configDir(), "session.json");
}
function parseCookieHeader(header) {
  const out = {};
  for (const part of header.replace(/^cookie:\s*/i, "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0)
      continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name)
      out[name] = value;
  }
  return out;
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}
async function loadSession() {
  if (process.env.NOTE_COOKIE) {
    return { cookies: parseCookieHeader(process.env.NOTE_COOKIE), savedAt: "env" };
  }
  try {
    const raw = await readFile(sessionPath(), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT")
      return null;
    throw e;
  }
}
async function saveSession(session) {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 384 });
  await chmod(path, 384);
  return path;
}
async function clearSession() {
  try {
    await rm(sessionPath());
    return true;
  } catch (e) {
    if (e.code === "ENOENT")
      return false;
    throw e;
  }
}

// src/client.ts
var NOTE_ORIGIN = "https://note.com";
var EDITOR_ORIGIN = "https://editor.note.com";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

class CliError extends Error {
  code;
  status;
  detail;
  constructor(code, message, opts = {}) {
    super(message);
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

class NoteClient {
  session;
  fetchImpl;
  minIntervalMs;
  lastRequestAt = 0;
  constructor(opts = {}) {
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env.NOTE_CLI_INTERVAL_MS ?? 500);
  }
  async getSession() {
    if (this.session === undefined)
      this.session = await loadSession();
    return this.session;
  }
  async request(path, opts = {}) {
    const method = opts.method ?? "GET";
    const url = new URL(path.startsWith("http") ? path : `${NOTE_ORIGIN}/api${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined)
        url.searchParams.set(k, String(v));
    }
    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "application/json"
    };
    const authMode = opts.auth ?? "none";
    if (authMode !== "none") {
      const session = await this.getSession();
      if (!session || !session.cookies._note_session_v5) {
        if (authMode === "required") {
          throw new CliError("NOT_LOGGED_IN", "Not logged in. Run `note-cli auth login` (or `note-cli auth import`).");
        }
      } else {
        headers.Cookie = cookieHeader(session.cookies);
        const xsrf = session.cookies["XSRF-TOKEN"];
        if (xsrf)
          headers["X-XSRF-TOKEN"] = safeDecode(xsrf);
      }
    }
    if (method !== "GET") {
      const origin = opts.editor ? EDITOR_ORIGIN : NOTE_ORIGIN;
      headers.Origin = origin;
      headers.Referer = `${origin}/`;
      headers["X-Requested-With"] = "XMLHttpRequest";
    }
    let body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    await this.throttle();
    if (process.env.NOTE_CLI_DEBUG)
      console.error(`[note-cli] ${method} ${url}`);
    let res;
    try {
      res = await this.fetchImpl(url, { method, headers, body });
    } catch (e) {
      throw new CliError("NETWORK_ERROR", `Request failed: ${e.message}`);
    }
    const text = await res.text();
    let data = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {}
    }
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? "AUTH_ERROR" : res.status === 404 ? "NOT_FOUND" : res.status === 429 ? "RATE_LIMITED" : "API_ERROR";
      const hint = code === "AUTH_ERROR" ? " Session may be expired; run `note-cli auth login` again." : "";
      const apiMessage = data?.error?.message;
      const suffix = typeof apiMessage === "string" ? ` ${apiMessage}` : "";
      throw new CliError(code, `${method} ${url.pathname} -> HTTP ${res.status}.${suffix}${hint}`, {
        status: res.status,
        detail: typeof data === "string" ? data.slice(0, 500) : data
      });
    }
    return data;
  }
  async throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0)
      await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}
function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// src/normalize.ts
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null)
      return obj[k];
  }
  return;
}
function normalizeNote(raw) {
  const user = raw.user ?? {};
  const urlname = pick(user, "urlname") ?? null;
  const key = String(pick(raw, "key") ?? "");
  const price = Number(pick(raw, "price") ?? 0);
  const hashtags = (pick(raw, "hashtags") ?? []).map((h) => h?.hashtag?.name ?? h?.name ?? (typeof h === "string" ? h : null)).filter((h) => Boolean(h)).map((h) => h.replace(/^#/, ""));
  return {
    id: pick(raw, "id") ?? null,
    key,
    title: String(pick(raw, "name") ?? ""),
    url: pick(raw, "noteUrl", "note_url") ?? (urlname ? `https://note.com/${urlname}/n/${key}` : `https://note.com/n/${key}`),
    status: pick(raw, "status") ?? null,
    author: { urlname, nickname: pick(user, "nickname", "name") ?? null },
    likeCount: Number(pick(raw, "like_count", "likeCount") ?? 0),
    commentCount: pick(raw, "comment_count", "commentCount") ?? null,
    price,
    isPaid: price > 0,
    publishAt: pick(raw, "publish_at", "publishAt") ?? null,
    hashtags,
    eyecatch: pick(raw, "eyecatch", "eyecatch_url", "eyecatchUrl") || null,
    imageCount: pick(raw, "image_count", "imageCount") ?? null
  };
}

// src/api.ts
async function searchNotes(client, q, opts = {}) {
  const limit = opts.limit ?? 20;
  const pageSize = 20;
  let start = opts.start ?? 0;
  const items = [];
  let total = null;
  let exhausted = false;
  while (items.length < limit) {
    const res = await client.request("/v3/searches", {
      auth: "optional",
      query: { context: "note", q, size: Math.min(pageSize, limit - items.length), start, sort: opts.sort ?? "popular" }
    });
    const notes = res?.data?.notes ?? {};
    const contents = notes.contents ?? [];
    total = notes.total_count ?? total;
    items.push(...contents.map(normalizeNote));
    start += contents.length;
    if (notes.is_last_page || contents.length === 0) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted };
}
async function hashtagNotes(client, tag, opts = {}) {
  const limit = opts.limit ?? 50;
  const name = tag.replace(/^#/, "");
  const items = [];
  let total = null;
  let exhausted = false;
  for (let page = 1;items.length < limit; page++) {
    const res = await client.request(`/v3/hashtags/${encodeURIComponent(name)}/notes`, {
      auth: "optional",
      query: { order: opts.order ?? "popular", page, paid_only: opts.paidOnly ? "true" : undefined }
    });
    const data = res?.data ?? {};
    const notes = data.notes ?? [];
    total = data.count ?? total;
    items.push(...notes.map(normalizeNote));
    if (data.is_last_page || notes.length === 0) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted };
}
async function creatorNotes(client, urlname, opts = {}) {
  const limit = opts.limit ?? 50;
  const items = [];
  let total = null;
  let exhausted = false;
  for (let page = 1;items.length < limit; page++) {
    const res = await client.request(`/v2/creators/${encodeURIComponent(urlname)}/contents`, {
      auth: "optional",
      query: { kind: "note", page }
    });
    const data = res?.data ?? {};
    const contents = data.contents ?? [];
    total = data.totalCount ?? total;
    items.push(...contents.map(normalizeNote));
    if (data.isLastPage || contents.length === 0) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted };
}
async function getCreator(client, urlname) {
  const res = await client.request(`/v2/creators/${encodeURIComponent(urlname)}`, { auth: "optional" });
  return res?.data;
}
async function getNote(client, key) {
  const res = await client.request(`/v3/notes/${encodeURIComponent(key)}`, { auth: "optional" });
  return res?.data;
}
async function currentUser(client) {
  const res = await client.request("/v2/current_user", { auth: "required" });
  if (!res?.data)
    throw new CliError("AUTH_ERROR", "current_user returned no data; session is likely invalid.");
  return res.data;
}
async function getDraft(client, key) {
  const res = await client.request(`/v3/notes/${encodeURIComponent(key)}`, {
    auth: "required",
    query: { draft: "true", draft_reedit: "false" }
  });
  return res?.data;
}
async function resolveNoteId(client, idOrKey) {
  if (/^\d+$/.test(idOrKey))
    return { id: Number(idOrKey), key: null };
  const key = idOrKey.match(/n[0-9a-f]{12,}/)?.[0] ?? idOrKey;
  const data = await getDraft(client, key);
  if (!data?.id)
    throw new CliError("NOT_FOUND", `Could not resolve note id for "${idOrKey}".`);
  return { id: Number(data.id), key: data.key ?? key };
}
async function myNotes(client, page = 1) {
  const res = await client.request("/v2/note_list/contents", { auth: "required", query: { page } });
  const data = res?.data ?? {};
  const list = data.notes ?? data.contents ?? (Array.isArray(data) ? data : []);
  return { items: list.map(normalizeNote), isLastPage: data.isLastPage ?? data.is_last_page ?? null };
}
function editUrl(key) {
  return `${EDITOR_ORIGIN}/notes/${key}/edit/`;
}
async function createDraft(client, title) {
  const res = await client.request("/v1/text_notes", {
    method: "POST",
    auth: "required",
    editor: true,
    json: { body: "<p></p>", body_length: 0, name: title, index: false, is_lead_form: false }
  });
  const d = res?.data ?? res;
  const note = d?.note ?? d?.text_note ?? d;
  const id = note?.id ?? d?.note_id;
  const key = note?.key ?? d?.note_key;
  if (!id || !key) {
    throw new CliError("API_ERROR", "Draft was created but id/key were missing from the response.", { detail: res });
  }
  return { id: Number(id), key, editUrl: editUrl(key) };
}
async function saveDraft(client, id, body) {
  const res = await client.request("/v1/text_notes/draft_save", {
    method: "POST",
    auth: "required",
    editor: true,
    query: { id },
    json: { name: body.title, body: body.html, body_length: body.bodyLength, index: false, is_lead_form: false }
  });
  return res?.data ?? res;
}
async function deleteDraft(client, id) {
  const res = await client.request("/v1/text_notes/draft_delete", {
    method: "DELETE",
    auth: "required",
    editor: true,
    query: { id }
  });
  return res?.data ?? res;
}
async function statsPv(client, opts = {}) {
  const res = await client.request("/v1/stats/pv", {
    auth: "required",
    query: { filter: opts.filter ?? "all", page: opts.page ?? 1, sort: opts.sort ?? "pv" }
  });
  return res?.data ?? res;
}

// src/login.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile as readFile2, rm as rm2 } from "fs/promises";
import { tmpdir } from "os";
import { join as join2 } from "path";
function browserCandidates() {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      ];
    case "win32": {
      const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
      return roots.flatMap((r) => [
        join2(r, "Google/Chrome/Application/chrome.exe"),
        join2(r, "Microsoft/Edge/Application/msedge.exe")
      ]);
    }
    default:
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  }
}
function findBrowser(explicit) {
  const path = explicit || process.env.NOTE_CLI_BROWSER || browserCandidates().find((p) => existsSync(p));
  if (!path || !existsSync(path)) {
    throw new CliError("BROWSER_NOT_FOUND", "No Chrome/Edge/Chromium found. Pass --browser <path> (or set NOTE_CLI_BROWSER), or use `note-cli auth import`.");
  }
  return path;
}

class Cdp {
  nextId = 1;
  pending = new Map;
  ws;
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p)
        return;
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(new Error(msg.error.message));
      else
        p.resolve(msg.result);
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForDevToolsPort(profileDir, proc, timeoutMs = 20000) {
  const file = join2(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new CliError("BROWSER_LAUNCH_FAILED", "Browser exited before it was ready.");
    try {
      const [port, path] = (await readFile2(file, "utf8")).trim().split(`
`);
      if (port && path)
        return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await sleep(200);
  }
  throw new CliError("BROWSER_LAUNCH_FAILED", "Timed out waiting for the browser's DevTools port.");
}
async function browserLogin(opts) {
  const executable = findBrowser(opts.browser);
  const profileDir = await mkdtemp(join2(tmpdir(), "note-cli-login-"));
  const proc = spawn(executable, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "https://note.com/login"
  ], { stdio: "ignore" });
  let cdp;
  try {
    cdp = await Cdp.connect(await waitForDevToolsPort(profileDir, proc));
    console.error("Log in to note.com in the opened browser window. Waiting...");
    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new CliError("LOGIN_ABORTED", "The browser was closed before login completed.");
      const { targetInfos } = await cdp.send("Target.getTargets");
      const onLoginPage = targetInfos.some((t) => t.type === "page" && /note\.com\/login/.test(t.url));
      if (!onLoginPage) {
        const { cookies } = await cdp.send("Storage.getCookies");
        const map = Object.fromEntries(cookies.filter((c) => /(^|\.)note\.com$/.test(c.domain.replace(/^\./, ""))).map((c) => [c.name, c.value]));
        if (map._note_session_v5 && await opts.isLoggedIn(map))
          return map;
      }
      await sleep(1500);
    }
    throw new CliError("LOGIN_TIMEOUT", `Login was not completed within ${opts.timeoutSec}s.`);
  } finally {
    cdp?.close();
    proc.kill();
    await sleep(300);
    await rm2(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

// src/markdown.ts
import { randomUUID } from "crypto";

// node_modules/marked/lib/marked.esm.js
function H() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var S = H();
function se(a) {
  S = a;
}
var B = { exec: () => null };
function D(a) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
    return s || (s = a(n), e[n] = s), s;
  };
}
function c(a, e = "") {
  let t = typeof a == "string" ? a : a.source, n = { replace: (s, r) => {
    let o = typeof r == "string" ? r : r.source;
    return o = o.replace(T.caret, "$1"), t = t.replace(s, o), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
var Te = ((a = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + a);
  } catch {
    return false;
  }
})();
var T = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\][ \t]+\S/, listReplaceTask: /^\[[ xX]\][ \t]+/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/, numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (a) => new RegExp(`^( {0,3}${a})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: D((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: D((a) => new RegExp(`^ {0,${a}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: D((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`)), headingBeginRegex: D((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`)), pedanticHeadingBeginRegex: D((a) => new RegExp(`^ {0,${a}}#`)), htmlBeginRegex: D((a) => new RegExp(`^ {0,${a}}(?:</?(?:${K})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i")), blockquoteBeginRegex: D((a) => new RegExp(`^ {0,${a}}>`)) };
var ve = /^(?:[ \t]*(?:\n|$))+/;
var Ze = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var He = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
var W = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var je = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var oe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var Oe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
var we = c(Oe).replace(/bull/g, oe).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var Ge = c(Oe).replace(/bull/g, oe).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var ae = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
var Ne = /^[^\n]+/;
var le = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
var Fe = c(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", le).replace("title", /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).getRegex();
var Qe = c(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, oe).getRegex();
var K = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var ue = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var Ue = c("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", ue).replace("tag", K).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var Pe = (a) => c(ae).replace("hr", W).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", a).replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
var We = Pe(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var Ke = Pe(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
var Xe = c(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace("paragraph", Ke).getRegex();
var pe = { blockquote: Xe, code: Ze, def: Fe, fences: He, heading: je, hr: W, html: Ue, lheading: we, list: Qe, newline: ve, paragraph: We, table: B, text: Ne };
var xe = c("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", W).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}\t)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
var Ve = { ...pe, lheading: Ge, table: xe, paragraph: c(ae).replace("hr", W).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", xe).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex() };
var Je = { ...pe, html: c(`^ *(?:comment(?: *\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1>(?: *\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?>(?: *\\n{2,}|\\s*$))`).replace("comment", ue).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: B, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: c(ae).replace("hr", W).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", we).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var Ye = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var et = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var Se = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
var tt = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var $ = /[\p{P}\p{S}]/u;
var j = /[\s\p{P}\p{S}]/u;
var X = /[^\s\p{P}\p{S}]/u;
var nt = c(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, j).getRegex();
var rt = /[\p{Pi}\p{Ps}"']/u;
var ye = /(?!~)[\p{P}\p{S}]/u;
var st = /(?!~)[\s\p{P}\p{S}]/u;
var it = /(?:[^\s\p{P}\p{S}]|~)/u;
var ot = c(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Te ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var _e = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var at = c(_e, "u").replace(/punct/g, $).getRegex();
var lt = c(_e, "u").replace(/punct/g, ye).getRegex();
var ut = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
var pt = c(ut, "u").replace(/openQuote/g, rt).replace(/punct/g, $).getRegex();
var $e = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var ct = c($e, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, j).replace(/punct/g, $).getRegex();
var ht = c($e, "gu").replace(/notPunctSpace/g, it).replace(/punctSpace/g, st).replace(/punct/g, ye).getRegex();
var dt = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
var gt = c(dt, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, j).replace(/punct/g, $).getRegex();
var kt = c("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, j).replace(/punct/g, $).getRegex();
var ft = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
var mt = c(ft, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, j).replace(/punct/g, $).getRegex();
var xt = c(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, $).getRegex();
var bt = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var Rt = c(bt, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, j).replace(/punct/g, $).getRegex();
var Tt = c(/\\(punct)/, "gu").replace(/punct/g, $).getRegex();
var Ot = c(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu").replace(/punct/g, $).getRegex();
var wt = c(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var Pt = c(ue).replace("(?:-->|$)", "-->").getRegex();
var St = c("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", Pt).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var Le = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
var re = c(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", Le).getRegex();
var yt = c(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label", re).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).getRegex();
var _t = c(/^!?\[(label)\]\[(ref)\]/).replace("label", re).replace("ref", le).getRegex();
var $t = c(/^!?\[(ref)\](?:\[\])?/).replace("ref", le).getRegex();
var be = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
var Lt = c(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", Le).getRegex();
var Ct = c("reflink|nolink(?!\\()", "g").replace("reflink", c(/^!?\[(label)\]\[(ref)\]/).replace("label", Lt).replace("ref", be).getRegex()).replace("nolink", c(/^!?\[(ref)\](?:\[\])?/).replace("ref", be).getRegex()).getRegex();
var Re = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var It = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
var At = c(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, It).getRegex();
var ce = { _backpedal: B, anyPunctuation: Tt, anyPunctuationOutsideCode: Ot, autolink: wt, blockSkip: ot, br: Se, code: et, del: B, delLDelim: B, delRDelim: B, emStrongLDelim: at, emStrongRDelimAst: ct, emStrongRDelimUnd: kt, escape: Ye, link: yt, nolink: $t, punctuation: nt, reflink: _t, reflinkSearch: Ct, tag: St, text: tt, url: B };
var Et = { ...ce, emStrongLDelim: pt, emStrongRDelimAst: gt, emStrongRDelimUnd: mt, link: c(/^!?\[(label)\]\((.*?)\)/).replace("label", re).getRegex(), reflink: c(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", re).getRegex() };
var ie = { ...ce, emStrongRDelimAst: ht, emStrongLDelim: lt, delLDelim: xt, delRDelim: Rt, url: c(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", At).replace("protocol", Re).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: c(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", Re).replace(/emailProtocol/g, /(?:mailto|xmpp):/).replace("wwwStart", Te ? "(?<![^\\s*_~(])www\\." : "www\\.").getRegex() };
var zt = { ...ie, br: c(Se).replace("{2,}", "*").getRegex(), text: c(ie.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var V = { normal: pe, gfm: Ve, pedantic: Je };
var G = { normal: ce, gfm: ie, breaks: zt, pedantic: Et };
var Mt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var Ce = (a) => Mt[a];
function P(a, e) {
  if (e) {
    if (T.escapeTest.test(a))
      return a.replace(T.escapeReplace, Ce);
  } else if (T.escapeTestNoEncode.test(a))
    return a.replace(T.escapeReplaceNoEncode, Ce);
  return a;
}
function Ie(a) {
  return T.numericCharacterReference.test(a) ? a.replace(T.numericCharacterReferenceOrAmpersand, (e, t, n) => {
    if (t === undefined && n === undefined)
      return "&amp;";
    let s = t === undefined ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
    return s === 0 || s > 1114111 || s >= 55296 && s <= 57343 ? "\uFFFD" : s === 38 ? "&amp;" : String.fromCodePoint(s);
  }) : a;
}
function he(a) {
  try {
    a = encodeURI(a).replace(T.percentDecode, "%");
  } catch {
    return null;
  }
  return a;
}
function de(a, e) {
  let t = a.replace(T.findPipe, (r, o, i) => {
    let l = false, p = o;
    for (;--p >= 0 && i[p] === "\\"; )
      l = !l;
    return l ? "|" : " |";
  }), n = t.split(T.splitPipe), s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e)
    if (n.length > e)
      n.splice(e);
    else
      for (;n.length < e; )
        n.push("");
  for (;s < n.length; s++)
    n[s] = n[s].trim().replace(T.slashPipe, "|");
  return n;
}
function L(a, e, t) {
  let n = a.length;
  if (n === 0)
    return "";
  let s = 0;
  for (;s < n; ) {
    let r = a.charAt(n - s - 1);
    if (r === e && !t)
      s++;
    else if (r !== e && t)
      s++;
    else
      break;
  }
  return a.slice(0, n - s);
}
function ge(a) {
  let e = a.split(`
`), t = e.length - 1;
  for (;t >= 0 && T.blankLine.test(e[t]); )
    t--;
  return e.length - t <= 2 ? a : e.slice(0, t + 1).join(`
`);
}
function F(a) {
  return a.trim().replace(T.multipleSpaceGlobal, " ").toLowerCase().toUpperCase().toLowerCase();
}
function ke(a, e) {
  if (a.indexOf(e[0]) === -1 && a.indexOf(e[1]) === -1)
    return -1;
  let t = 0;
  for (let n = 0;n < a.length; n++)
    if (a[n] === "\\")
      n++;
    else if (a[n] === e[0])
      t++;
    else if (a[n] === e[1] && (t--, t < 0))
      return n;
  return t > 0 ? -2 : -1;
}
var N = new WeakMap;
function fe(a) {
  let e = { "*": -1, _: -1 }, t = -1, n = a.length;
  for (let s = 0;s < n; s++) {
    let r = a[s];
    if (r !== "*" && r !== "_" && r !== "~")
      continue;
    let o = s === 0 ? `
` : a[s - 1], i = s + 1;
    for (;i < n && a[i] === r; )
      i++;
    o !== " " && o !== "\t" && o !== `
` && o !== "\r" && o !== "\f" && (r === "~" ? t = s : e[r] = s), s = i - 1;
  }
  return { maskedSrc: a, lastPossibleEmStrongCloserIndex: e, lastPossibleDelCloserIndex: t };
}
function Ae(a, e) {
  let t = fe(e), n = N.get(a);
  n ? n.push(t) : N.set(a, [t]);
}
function Ee(a) {
  let e = N.get(a);
  e && (e.pop(), e.length === 0 && N.delete(a));
}
function ze(a, e, t) {
  let n = N.get(a)?.at(-1);
  return n && n.maskedSrc === e ? n.lastPossibleEmStrongCloserIndex[t] : fe(e).lastPossibleEmStrongCloserIndex[t];
}
function Me(a, e) {
  let t = N.get(a)?.at(-1);
  return t && t.maskedSrc === e ? t.lastPossibleDelCloserIndex : fe(e).lastPossibleDelCloserIndex;
}
function J(a, e = 0) {
  let t = e, n = "";
  for (let s of a)
    if (s === "\t") {
      let r = 4 - t % 4;
      n += " ".repeat(r), t += r;
    } else
      n += s, t++;
  return n;
}
function De(a, e, t, n, s) {
  let r = e.href, o = e.title || null, i = a[1].replace(s.other.outputLinkReplace, "$1"), l = a[0].charAt(0) === "!", p = n.state.inLink, h = n.state.linkEmitted, u = n.state.inRawBlock;
  n.state.inLink = true, n.state.linkEmitted = false;
  let d = n.inlineTokens(i), k = n.state.linkEmitted;
  if (n.state.linkEmitted = h, n.state.inLink = p, !l) {
    if (k) {
      n.state.inRawBlock = u;
      return;
    }
    n.state.linkEmitted = true;
  }
  return { type: l ? "image" : "link", raw: t, href: r, title: o, text: i, tokens: d };
}
function Dt(a, e, t) {
  let n = a.match(t.other.indentCodeCompensation);
  if (n === null)
    return e;
  let s = n[1];
  return e.split(`
`).map((r) => {
    let o = r.match(t.other.beginningSpace);
    if (o === null)
      return r;
    let [i] = o;
    return r.slice(Math.min(i.length, s.length));
  }).join(`
`);
}
function Be(a, e, t, n) {
  if (!e.includes("<"))
    return false;
  for (let s = 0;s < e.length; s++) {
    if (e[s] === "\\") {
      s++;
      continue;
    }
    if (e[s] === "`") {
      let i = n.inline.code.exec(e.slice(s));
      if (i) {
        s += i[0].length - 1;
        continue;
      }
    }
    if (e[s] !== "<")
      continue;
    let r = a.slice(t + s), o = n.inline.tag.exec(r) || n.inline.autolink.exec(r);
    if (o) {
      if (o[0].length > e.length - s)
        return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
var _ = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || S;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0)
      return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = this.options.pedantic ? t[0] : ge(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], s = Dt(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let s = L(n, "#");
        (this.options.pedantic || !s || this.rules.other.endingSpaceTabChar.test(s)) && (n = s.trim());
      }
      return { type: "heading", raw: L(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t)
      return { type: "hr", raw: L(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = L(t[0], `
`).split(`
`), s = "", r = "", o = [];
      for (;n.length > 0; ) {
        let i = false, l = [], p;
        for (p = 0;p < n.length; p++)
          if (this.rules.other.blockquoteStart.test(n[p]))
            l.push(n[p]), i = true;
          else if (!i)
            l.push(n[p]);
          else
            break;
        n = n.slice(p);
        let h = l.join(`
`), u = h.replace(this.rules.other.blockquoteMarkerWhitespace, (g, b, m) => b + J(m, b.length)).replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        s = s ? `${s}
${h}` : h, r = r ? `${r}
${u}` : u;
        let d = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(u, o, true), this.lexer.state.top = d, n.length === 0)
          break;
        let k = o.at(-1);
        if (k?.type === "code" || k?.type === "heading" || k?.type === "hr" || k?.type === "html" || k?.type === "table")
          break;
        if (k?.type === "blockquote") {
          let g = k, b = n.join(`
`), m = g.raw + `
` + b.replace(this.rules.other.blockquoteSetextReplace2, ""), f = this.blockquote(m);
          o[o.length - 1] = f;
          let y = m.substring(f.raw.length).replace(/^\n/, ""), R = y ? y.split(`
`).length : 0, A = R ? n.slice(0, -R) : n;
          if (A.length > 0 && (s = `${s}
${A.join(`
`)}`), r = r.substring(0, r.length - g.text.length) + f.text, n = n.slice(A.length), n.length > 0 && this.rules.other.blockquoteStart.test(n[0]))
            continue;
          break;
        } else if (k?.type === "list") {
          let g = k, b = g.raw + `
` + n.join(`
`), m = this.list(b);
          o[o.length - 1] = m;
          let f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split(`
`).length : 0;
          if (f > 0) {
            let y = n.slice(0, f).join(`
`);
            s = `${s}
${y}`, r = `${r}
${y}`;
          }
          n = n.slice(f);
          continue;
        }
      }
      return { type: "blockquote", raw: s, tokens: o, text: r };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = e, s = () => n.length - e.length, r = t[1].trim(), o = r.length > 1, i = { type: "list", raw: "", ordered: o, start: o ? +r.slice(0, -1) : "", loose: false, items: [] };
      r = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`, this.options.pedantic && (r = o ? r : "[*+-]");
      let l = this.rules.other.listItemRegex(r), p = false;
      for (;e; ) {
        let u = false, d = "";
        if (!(t = l.exec(e)) || this.rules.block.hr.test(e))
          break;
        let k = s();
        e = e.substring(t[0].length);
        let g = t[2].split(`
`, 1)[0], b = t[1].length, m = this.options.pedantic ? J(g, b) : g.replace(this.rules.other.leadingSpaceTab, (v) => J(v, b)), f = e.split(`
`, 1)[0], y = !m.trim(), R = 0;
        if (this.options.pedantic ? (R = 2, d = m.trimStart()) : y ? R = b + 1 : (R = m.search(this.rules.other.nonSpaceChar), R = R > 4 ? 1 : R, d = m.slice(R), R += b), y && this.rules.other.blankLine.test(f) && (e = e.substring(f.length + 1), u = true), !u) {
          let v = this.rules.other.nextBulletRegex(R), Q = this.rules.other.hrRegex(R), ee = this.rules.other.fencesBeginRegex(R), te = this.options.pedantic ? this.rules.other.pedanticHeadingBeginRegex(R) : this.rules.other.headingBeginRegex(R), M = this.rules.other.htmlBeginRegex(R), ne = this.rules.other.blockquoteBeginRegex(R);
          for (;e; ) {
            let U = e.split(`
`, 1)[0], Z;
            if (f = U, this.options.pedantic ? (f = f.replace(this.rules.other.listReplaceNesting, "  "), Z = f) : Z = f.replace(this.rules.other.leadingSpaceTab, (me) => J(me)), ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f))
              break;
            if (Z.search(this.rules.other.nonSpaceChar) >= R || !f.trim())
              d += `
` + Z.slice(R);
            else {
              if (y || m.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m))
                break;
              let qe = !this.options.pedantic && /^ {0,3}(?:=+|-+) *$/.test(f) && this.rules.block.lheading.test(`${m}
${f}`) ? `    ${Z.replace(/^ {0,3}/, "")}` : f;
              d += `
` + qe;
            }
            y = !f.trim(), e = e.substring(U.length + 1), m = Z.slice(R);
          }
        }
        let A = n.slice(k, s());
        i.loose || (p ? i.loose = true : this.rules.other.doubleBlankLine.test(A) && (p = true)), i.items.push({ type: "list_item", raw: A, task: !!this.options.gfm && this.rules.other.listIsTask.test(d), loose: false, text: d, tokens: [] });
      }
      let h = i.items.at(-1);
      if (h)
        h.raw = h.raw.trimEnd(), h.text = h.text.trimEnd();
      else
        return;
      i.raw = n.slice(0, s()).trimEnd();
      for (let u of i.items)
        if (this.lexer.state.top = false, u.tokens = this.lexer.blockTokens(u.text, []), !i.loose) {
          let d = u.tokens.filter((g) => g.type === "space"), k = d.length > 0 && d.some((g) => this.rules.other.anyLine.test(g.raw));
          i.loose = k;
        }
      for (let u of i.items) {
        let d = u.tokens[0];
        if (u.task && (d?.type === "text" || d?.type === "paragraph")) {
          u.text = u.text.replace(this.rules.other.listReplaceTask, ""), d.raw = d.raw.replace(this.rules.other.listReplaceTask, ""), d.text = d.text.replace(this.rules.other.listReplaceTask, "");
          for (let g = this.lexer.inlineQueue.length - 1;g >= 0; g--)
            if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
              this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
          let k = this.rules.other.listTaskCheckbox.exec(u.raw);
          if (k) {
            let g = { type: "checkbox", raw: k[0] + " ", checked: k[0] !== "[ ]" };
            u.checked = g.checked, i.loose ? u.tokens[0] && ["paragraph", "text"].includes(u.tokens[0].type) && "tokens" in u.tokens[0] && u.tokens[0].tokens ? (u.tokens[0].raw = g.raw + u.tokens[0].raw, u.tokens[0].text = g.raw + u.tokens[0].text, u.tokens[0].tokens.unshift(g)) : u.tokens.unshift({ type: "paragraph", raw: g.raw, text: g.raw, tokens: [g] }) : u.tokens.unshift(g);
          }
        } else
          u.task && (u.task = false);
      }
      if (i.loose)
        for (let u of i.items) {
          u.loose = true;
          for (let d of u.tokens)
            d.type === "text" && (d.type = "paragraph");
        }
      return i;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) {
      let n = ge(t[0]);
      return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
    }
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      if (!this.rules.other.startAngleBracket.test(t[2]) && ke(t[2], "()") !== -1)
        return;
      let n = F(t[1]), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: L(t[0], `
`), href: s, title: r };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2]))
      return;
    let n = de(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], o = { type: "table", raw: L(t[0], `
`), header: [], align: [], rows: [] };
    if (n.length === s.length) {
      for (let i of s)
        this.rules.other.tableAlignRight.test(i) ? o.align.push("right") : this.rules.other.tableAlignCenter.test(i) ? o.align.push("center") : this.rules.other.tableAlignLeft.test(i) ? o.align.push("left") : o.align.push(null);
      for (let i = 0;i < n.length; i++)
        o.header.push({ text: n[i], tokens: this.lexer.inline(n[i]), header: true, align: o.align[i] });
      for (let i of r)
        o.rows.push(de(i, o.header.length).map((l, p) => ({ text: l, tokens: this.lexer.inline(l), header: false, align: o.align[p] })));
      return o;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return { type: "heading", raw: L(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t)
      return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t)
      return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t)
      return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    if (this.lexer.state.linkParenPossible === false)
      return;
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && Be(e, t[1], n, this.rules))
        return;
      let s = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(s)) {
        if (!this.rules.other.endAngleBracket.test(s))
          return;
        let l = L(s.slice(0, -1), "\\");
        if ((s.length - l.length) % 2 === 0)
          return;
      } else {
        let l = ke(t[2], "()");
        if (l === -2)
          return;
        if (l > -1) {
          let h = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + l;
          t[2] = t[2].substring(0, l), t[0] = t[0].substring(0, h).trim(), t[3] = "";
        }
      }
      let r = L(t[0].slice(0, -1), "\\");
      if ((t[0].length - r.length) % 2 === 0)
        return;
      let o = t[2], i = "";
      if (this.options.pedantic) {
        let l = this.rules.other.pedanticHrefTitle.exec(o);
        l && (o = l[1], i = l[3]);
      } else
        i = t[3] ? t[3].slice(1, -1) : "";
      return o = o.trim(), this.rules.other.startAngleBracket.test(o) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(s) ? o = o.slice(1) : o = o.slice(1, -1)), De(t, { href: o && o.replace(this.rules.inline.anyPunctuation, "$1"), title: i && i.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let s = n[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && Be(e, n[1], s, this.rules))
        return;
      let r = t[F(n[2] || n[1])];
      if (!r) {
        let o = n[0].charAt(0);
        return { type: "text", raw: o, text: o };
      }
      return De(n, r, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let s = this.rules.inline.emStrongLDelim.exec(e);
    if (!s || !s[1] && !s[2] && !s[3] && !s[4])
      return;
    let r = s[0][0], o = n === r, i = t.length - e.length, l = i;
    for (;!this.options.pedantic && l > 0 && t[l - 1] === r; )
      l--;
    let p = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? "", h = p === "*" || p === "_" || !!this.rules.inline.punctuation.exec(p);
    l < i && (n = p);
    let u = l < i ? h : !!this.rules.inline.punctuation.exec(n);
    if (s[4] && n.match(this.rules.other.unicodeAlphaNumeric))
      return;
    let d = s[1] || s[3] || "";
    if (!d || !n || u) {
      let k = [...s[0]].length - 1, g, b, m = k, f = 0, y = i - l + k, R = !this.options.pedantic && !!p.trim() && (!!d || r === "*" && !h);
      if (r !== "*" && r !== "_")
        return;
      let A = r === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd, v = ze(this, t, r), Q = t.length - e.length + k;
      if (v < Q)
        return;
      t = t.slice(-1 * e.length + k);
      let ee = v - Q;
      for (A.lastIndex = 0;(s = A.exec(t)) !== null && !(s.index > ee); ) {
        if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g)
          continue;
        if (b = [...g].length, s[3] || s[4]) {
          m += b;
          continue;
        } else if (s[5] || s[6] || R) {
          if (o && (s[5] || s[6]))
            break;
          if (y % 3 && !((y + b) % 3)) {
            f += b;
            continue;
          }
        }
        if (m -= b, m > 0)
          continue;
        b = Math.min(b, b + m + f);
        let te = [...s[0]][0].length, M = e.slice(0, k + s.index + te + b);
        if (Math.min(k, b) % 2) {
          let U = M.slice(1, -1);
          return { type: "em", raw: M, text: U, tokens: this.lexer.inlineTokens(U) };
        }
        let ne = M.slice(2, -2);
        return { type: "strong", raw: M, text: ne, tokens: this.lexer.inlineTokens(ne) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return s && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t)
      return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let s = this.rules.inline.delLDelim.exec(e);
    if (!s)
      return;
    if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let o = [...s[0]].length - 1, i, l, p = o, h = this.rules.inline.delRDelim, u = Me(this, t), d = t.length - e.length + o;
      if (u < d)
        return;
      t = t.slice(-1 * e.length + o);
      let k = u - d;
      for (h.lastIndex = 0;(s = h.exec(t)) !== null && !(s.index > k); ) {
        if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i || (l = [...i].length, l !== o))
          continue;
        if (s[3] || s[4]) {
          p += l;
          continue;
        }
        if (p -= l, p > 0)
          continue;
        l = Math.min(l, l + p);
        let g = [...s[0]][0].length, b = e.slice(0, o + s.index + g + l), m = b.slice(o, -o);
        return { type: "del", raw: b, text: m, tokens: this.lexer.inlineTokens(m) };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, s;
      return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, s;
      if (t[2] === "@")
        n = t[0], s = "mailto:" + n;
      else {
        let r;
        do
          r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (r !== t[0]);
        n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: n ? t[0] : Ie(t[0]), escaped: n };
    }
  }
};
var O = class a {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = Object.create(null), this.options = e || S, this.options.tokenizer = this.options.tokenizer || new _, this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    let t = { other: T, block: V.normal, inline: G.normal };
    this.options.pedantic ? (t.block = V.pedantic, t.inline = G.pedantic) : this.options.gfm && (t.block = V.gfm, this.options.breaks ? t.inline = G.breaks : t.inline = G.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: V, inline: G };
  }
  static lex(e, t) {
    return new a(t).lex(e);
  }
  static lexInline(e, t) {
    return new a(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(T.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0;t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.state.inRawBlock = false, this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(T.tabCharGlobal, "    ").replace(T.spaceLine, ""));
    let s = 1 / 0;
    for (;e; ) {
      if (e.length < s)
        s = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (this.options.extensions?.block?.some((i) => (r = i.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false))
        continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        r.raw.length === 1 && i !== undefined ? i.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.at(-1).src = i.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.raw, this.inlineQueue.at(-1).src = i.text) : (this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }), t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let o = e;
      if (this.options.extensions?.startBlock) {
        let i = 1 / 0, l = e.slice(1), p;
        this.options.extensions.startBlock.forEach((h) => {
          p = h.call({ lexer: this }, l), typeof p == "number" && p >= 0 && (i = Math.min(i, p));
        }), i < 1 / 0 && i >= 0 && (o = e.substring(0, i + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(o))) {
        let i = t.at(-1);
        n && i?.type === "paragraph" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  linkInText(e) {
    if (!e.includes("["))
      return false;
    let t = this.tokenizer.rules.inline.link;
    for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip))
      if (t.test(n[0]) && e.charAt(n.index - 1) !== "!")
        return true;
    for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      let s = n[0], r = s.lastIndexOf("[");
      if (!(s.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, F(s.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(s.slice(1, r - 1))))
        return true;
    }
    return false;
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = this.state.linkParenPossible;
    this.state.linkParenPossible = n && e.includes(")");
    try {
      return this.#e(e, t);
    } finally {
      this.state.linkParenPossible = n;
    }
  }
  #e(e, t) {
    let n = e.includes("*") || e.includes("_") || e.includes("~") || this.options.hooks?.emStrongMask || this.tokenizer.emStrong !== _.prototype.emStrong || this.tokenizer.del !== _.prototype.del ? this.#n(e) : e;
    Ae(this.tokenizer, n);
    try {
      return this.#t(e, n, t);
    } finally {
      Ee(this.tokenizer);
    }
  }
  #t(e, t, n) {
    let s = false, r = "", o = 1 / 0;
    for (;e; ) {
      if (e.length < o)
        o = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      s || (r = ""), s = false;
      let i;
      if (this.options.extensions?.inline?.some((p) => (i = p.call({ lexer: this }, e, n)) ? (e = e.substring(i.raw.length), n.push(i), true) : false))
        continue;
      if (i = this.tokenizer.escape(e)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (i = this.tokenizer.tag(e)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (i = this.tokenizer.link(e)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (i = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(i.raw.length);
        let p = n.at(-1);
        i.type === "text" && p?.type === "text" ? (p.raw += i.raw, p.text += i.text) : n.push(i);
        continue;
      }
      if (i = this.tokenizer.emStrong(e, t, r)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (i = this.tokenizer.codespan(e)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (i = this.tokenizer.br(e)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (i = this.tokenizer.del(e, t, r)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (i = this.tokenizer.autolink(e)) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      if (!this.state.inLink && (i = this.tokenizer.url(e))) {
        e = e.substring(i.raw.length), n.push(i);
        continue;
      }
      let l = e;
      if (this.options.extensions?.startInline) {
        let p = 1 / 0, h = e.slice(1), u;
        this.options.extensions.startInline.forEach((d) => {
          u = d.call({ lexer: this }, h), typeof u == "number" && u >= 0 && (p = Math.min(p, u));
        }), p < 1 / 0 && p >= 0 && (l = e.substring(0, p + 1));
      }
      if (i = this.tokenizer.inlineText(l)) {
        e = e.substring(i.raw.length), i.raw.slice(-1) !== "_" && (r = i.raw.slice(-1)), s = true;
        let p = n.at(-1);
        p?.type === "text" ? (p.raw += i.raw, p.text += i.text) : n.push(i);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return n;
  }
  #n(e) {
    let t = e;
    if (this.tokens.links && e.includes("[")) {
      let n = this.tokenizer.rules.inline.reflinkSearch, s = (r) => {
        let o = r.lastIndexOf("[");
        if (!Object.hasOwn(this.tokens.links, F(r.slice(o + 1, -1))))
          return r;
        if (o > 1 && r.charAt(0) !== "!") {
          let i = r.slice(1, o - 1);
          if (this.linkInText(i))
            return "[" + i.replace(n, s) + "][" + "a".repeat(r.length - o - 2) + "]";
        }
        return "[" + "a".repeat(r.length - 2) + "]";
      };
      t = t.replace(n, s);
    }
    return t = t.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (n, s, r) => r ? "+".repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, "+") + s : n), t = t.replace(this.tokenizer.rules.inline.blockSkip, (n, s, r) => {
      let o = r ? r.length : 0;
      return n.slice(0, o) + "[" + "a".repeat(n.length - o - 2) + "]";
    }), t = this.options.hooks?.emStrongMask?.call({ lexer: this }, t) ?? t, t;
  }
  infiniteLoopError(e) {
    let t = "Infinite loop on byte: " + e;
    if (this.options.silent)
      console.error(t);
    else
      throw new Error(t);
  }
};
var C = class {
  options;
  parser;
  constructor(e) {
    this.options = e || S;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let s = (t || "").match(T.notSpaceStart)?.[0], r = e ? e.replace(T.endingNewline, "") + `
` : "";
    return s ? '<pre><code class="language-' + P(s) + '">' + (n ? r : P(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : P(r, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let { ordered: t, start: n } = e, s = "";
    for (let i = 0;i < e.items.length; i++) {
      let l = e.items[i];
      s += this.listitem(l);
    }
    let r = t ? "ol" : "ul", o = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + r + o + `>
` + s + "</" + r + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let r = 0;r < e.header.length; r++)
      n += this.tablecell(e.header[r]);
    t += this.tablerow({ text: n });
    let s = "";
    for (let r = 0;r < e.rows.length; r++) {
      let o = e.rows[r];
      n = "";
      for (let i = 0;i < o.length; i++)
        n += this.tablecell(o[i]);
      s += this.tablerow({ text: n });
    }
    return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${P(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, text: n, tokens: s, autolink: r }) {
    let o = r ? P(n, true) : this.parser.parseInline(s), i = he(e);
    if (i === null)
      return o;
    e = P(i, r);
    let l = '<a href="' + e + '"';
    return t && (l += ' title="' + P(t) + '"'), l += ">" + o + "</a>", l;
  }
  image({ href: e, title: t, text: n, tokens: s }) {
    s && (n = this.parser.parseInline(s, this.parser.textRenderer));
    let r = he(e);
    if (r === null)
      return P(n);
    e = r;
    let o = `<img src="${P(e)}" alt="${P(n)}"`;
    return t && (o += ` title="${P(t)}"`), o += ">", o;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : ("escaped" in e) && e.escaped ? e.text : P(e.text);
  }
};
var E = class {
  parser;
  strong({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  em({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  image({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var w = class a2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || S, this.options.renderer = this.options.renderer || new C, this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new E, this.textRenderer.parser = this;
  }
  static parse(e, t) {
    return new a2(t).parse(e);
  }
  static parseInline(e, t) {
    return new a2(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0;n < e.length; n++) {
      let s = e[n];
      if (this.options.extensions?.renderers?.[s.type]) {
        let o = s, i = this.options.extensions.renderers[o.type].call({ parser: this }, o);
        if (i !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(o.type)) {
          t += i || "";
          continue;
        }
      }
      let r = s;
      switch (r.type) {
        case "space": {
          t += this.renderer.space(r);
          break;
        }
        case "hr": {
          t += this.renderer.hr(r);
          break;
        }
        case "heading": {
          t += this.renderer.heading(r);
          break;
        }
        case "code": {
          t += this.renderer.code(r);
          break;
        }
        case "table": {
          t += this.renderer.table(r);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(r);
          break;
        }
        case "list": {
          t += this.renderer.list(r);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(r);
          break;
        }
        case "html": {
          t += this.renderer.html(r);
          break;
        }
        case "def": {
          t += this.renderer.def(r);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(r);
          break;
        }
        case "text": {
          t += this.renderer.text(r);
          break;
        }
        default: {
          let o = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent)
            return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let s = 0;s < e.length; s++) {
      let r = e[s];
      if (this.options.extensions?.renderers?.[r.type]) {
        let i = this.options.extensions.renderers[r.type].call({ parser: this }, r);
        if (i !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
          n += i || "";
          continue;
        }
      }
      let o = r;
      switch (o.type) {
        case "escape": {
          n += t.text(o);
          break;
        }
        case "html": {
          n += t.html(o);
          break;
        }
        case "link": {
          n += t.link(o);
          break;
        }
        case "image": {
          n += t.image(o);
          break;
        }
        case "checkbox": {
          n += t.checkbox(o);
          break;
        }
        case "strong": {
          n += t.strong(o);
          break;
        }
        case "em": {
          n += t.em(o);
          break;
        }
        case "codespan": {
          n += t.codespan(o);
          break;
        }
        case "br": {
          n += t.br(o);
          break;
        }
        case "del": {
          n += t.del(o);
          break;
        }
        case "text": {
          n += t.text(o);
          break;
        }
        default: {
          let i = 'Token with "' + o.type + '" type was not found.';
          if (this.options.silent)
            return console.error(i), "";
          throw new Error(i);
        }
      }
    }
    return n;
  }
};
var I = class {
  options;
  block;
  constructor(e) {
    this.options = e || S;
  }
  static passThroughHooks = new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? O.lex : O.lexInline;
  }
  provideParser(e = this.block) {
    return e ? w.parse : w.parseInline;
  }
};
function z(a3, e) {
  if (Array.isArray(e))
    for (let t = 0;t < e.length; t++)
      a3.push(e[t]);
  else
    a3.push(e);
}
var Y = class {
  defaults = H();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = w;
  Renderer = C;
  TextRenderer = E;
  Lexer = O;
  Tokenizer = _;
  Hooks = I;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let s of e)
      switch (z(n, t.call(this, s)), s.type) {
        case "table": {
          let r = s;
          for (let o of r.header)
            z(n, this.walkTokens(o.tokens, t));
          for (let o of r.rows)
            for (let i of o)
              z(n, this.walkTokens(i.tokens, t));
          break;
        }
        case "list": {
          let r = s;
          z(n, this.walkTokens(r.items, t));
          break;
        }
        default: {
          let r = s;
          this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((o) => {
            let i = r[o].flat(1 / 0);
            z(n, this.walkTokens(i, t));
          }) : r.tokens && z(n, this.walkTokens(r.tokens, t));
        }
      }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: Object.create(null), childTokens: Object.create(null) };
    return e.forEach((n) => {
      let s = { ...n };
      if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((r) => {
        if (!r.name)
          throw new Error("extension name required");
        if ("renderer" in r) {
          let o = t.renderers[r.name];
          o ? t.renderers[r.name] = function(...i) {
            let l = r.renderer.apply(this, i);
            return l === false && (l = o.apply(this, i)), l;
          } : t.renderers[r.name] = r.renderer;
        }
        if ("tokenizer" in r) {
          if (!r.level || r.level !== "block" && r.level !== "inline")
            throw new Error("extension level must be 'block' or 'inline'");
          let o = t[r.level];
          o ? o.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
        }
        "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
      }), s.extensions = t), n.renderer) {
        let r = this.defaults.renderer || new C(this.defaults);
        for (let o in n.renderer) {
          if (!(o in r))
            throw new Error(`renderer '${o}' does not exist`);
          if (["options", "parser"].includes(o))
            continue;
          let i = o, l = n.renderer[i], p = r[i];
          r[i] = (...h) => {
            let u = l.apply(r, h);
            return u === false && (u = p.apply(r, h)), u === false ? "" : u ?? "";
          };
        }
        s.renderer = r;
      }
      if (n.tokenizer) {
        let r = this.defaults.tokenizer || new _(this.defaults);
        for (let o in n.tokenizer) {
          if (!(o in r))
            throw new Error(`tokenizer '${o}' does not exist`);
          if (["options", "rules", "lexer"].includes(o))
            continue;
          let i = o, l = n.tokenizer[i], p = r[i];
          r[i] = (...h) => {
            let u = l.apply(r, h);
            return u === false && (u = p.apply(r, h)), u;
          };
        }
        s.tokenizer = r;
      }
      if (n.hooks) {
        let r = this.defaults.hooks || new I;
        for (let o in n.hooks) {
          if (!(o in r))
            throw new Error(`hook '${o}' does not exist`);
          if (["options", "block"].includes(o))
            continue;
          let i = o, l = n.hooks[i], p = r[i];
          I.passThroughHooks.has(o) ? r[i] = (h) => {
            if (r.options.async && I.passThroughHooksRespectAsync.has(o))
              return (async () => {
                let d = await l.call(r, h);
                return p.call(r, d);
              })();
            let u = l.call(r, h);
            return p.call(r, u);
          } : r[i] = (...h) => {
            if (r.options.async)
              return (async () => {
                let d = await l.apply(r, h);
                return d === false && (d = await p.apply(r, h)), d;
              })();
            let u = l.apply(r, h);
            return u === false && (u = p.apply(r, h)), u;
          };
        }
        s.hooks = r;
      }
      if (n.walkTokens) {
        let r = this.defaults.walkTokens, o = n.walkTokens;
        s.walkTokens = function(i) {
          let l = [];
          return z(l, o.call(this, i)), r && z(l, r.call(this, i)), l;
        };
      }
      this.defaults = { ...this.defaults, ...s };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return O.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return w.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, s) => {
      let r = { ...s }, o = { ...this.defaults, ...r }, i = this.onError(!!o.silent, !!o.async);
      if (this.defaults.async === true && r.async === false)
        return i(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null)
        return i(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string")
        return i(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (o.hooks && (o.hooks.options = o, o.hooks.block = e), o.async)
        return (async () => {
          let l = o.hooks ? await o.hooks.preprocess(n) : n, h = await (o.hooks ? await o.hooks.provideLexer(e) : e ? O.lex : O.lexInline)(l, o), u = o.hooks ? await o.hooks.processAllTokens(h) : h;
          o.walkTokens && await Promise.all(this.walkTokens(u, o.walkTokens));
          let k = await (o.hooks ? await o.hooks.provideParser(e) : e ? w.parse : w.parseInline)(u, o);
          return o.hooks ? await o.hooks.postprocess(k) : k;
        })().catch(i);
      try {
        o.hooks && (n = o.hooks.preprocess(n));
        let p = (o.hooks ? o.hooks.provideLexer(e) : e ? O.lex : O.lexInline)(n, o);
        o.hooks && (p = o.hooks.processAllTokens(p)), o.walkTokens && this.walkTokens(p, o.walkTokens);
        let u = (o.hooks ? o.hooks.provideParser(e) : e ? w.parse : w.parseInline)(p, o);
        return o.hooks && (u = o.hooks.postprocess(u)), u;
      } catch (l) {
        return i(l);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let s = "<p>An error occurred:</p><pre>" + P(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(s) : s;
      }
      if (t)
        return Promise.reject(n);
      throw n;
    };
  }
};
var q = new Y;
function x(a3, e) {
  return q.parse(a3, e);
}
x.options = x.setOptions = function(a3) {
  return q.setOptions(a3), x.defaults = q.defaults, se(x.defaults), x;
};
x.getDefaults = H;
x.defaults = S;
function Bt(...a3) {
  return q.use(...a3), x.defaults = q.defaults, se(x.defaults), x;
}
x.use = Bt;
x.walkTokens = function(a3, e) {
  return q.walkTokens(a3, e);
};
x.parseInline = q.parseInline;
x.Parser = w;
x.parser = w.parse;
x.Renderer = C;
x.TextRenderer = E;
x.Lexer = O;
x.lexer = O.lex;
x.Tokenizer = _;
x.Hooks = I;
x.parse = x;
var _n = x.options;
var $n = x.setOptions;
var Ln = x.walkTokens;
var Cn = x.parseInline;
var An = w.parse;
var En = O.lex;

// src/markdown.ts
function parseArticle(source) {
  let markdown = source.replace(/^\uFEFF/, "").replace(/\r\n/g, `
`);
  const frontmatter = {};
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split(`
`)) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m)
        frontmatter[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
    markdown = markdown.slice(fm[0].length);
  }
  let title = frontmatter.title || undefined;
  if (!title) {
    const h1 = markdown.match(/^\s*#\s+(.+?)\s*#*\s*(\n|$)/);
    if (h1) {
      title = h1[1].trim();
      markdown = markdown.slice(h1[0].length);
    }
  }
  return { title, markdown: markdown.replace(/^\n+/, ""), frontmatter };
}
function markdownToNoteHtml(markdown) {
  const warnings = [];
  const marked = new Y({ gfm: true, breaks: true });
  marked.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth <= 2)
          return `<h2>${inner}</h2>
`;
        if (token.depth === 3)
          return `<h3>${inner}</h3>
`;
        return `<p><strong>${inner}</strong></p>
`;
      },
      image(token) {
        warnings.push(`Image "${token.href}" was not uploaded (image upload is not supported yet); replaced with a link. Add it in the note editor.`);
        const label = escapeHtml(token.text || token.href);
        return `<a href="${escapeAttr(token.href)}">${label}</a>`;
      },
      table(token) {
        warnings.push("Tables are not supported by note.com; rendered as a code block.");
        const rows = [token.header, ...token.rows].map((row) => row.map((cell) => cell.text).join(" | "));
        return `<pre><code>${escapeHtml(rows.join(`
`))}</code></pre>
`;
      },
      html(token) {
        warnings.push("Raw HTML in Markdown was escaped.");
        return escapeHtml(token.raw);
      }
    }
  });
  let html = marked.parse(markdown, { async: false });
  html = stripDangerous(html);
  html = addBlockIds(html).replace(/\n+<\/code><\/pre>/g, "</code></pre>").replace(/>\n+</g, "><").trim();
  if (!html)
    html = "<p></p>";
  return { html, bodyLength: visibleTextLength(html), warnings: [...new Set(warnings)] };
}
var BLOCK_TAGS = new Set(["p", "h2", "h3", "ul", "ol", "li", "blockquote", "pre", "figure", "hr"]);
function addBlockIds(html) {
  return html.replace(/<([a-z0-9]+)(\s[^>]*)?(\/?)>/gi, (match, tag, attrs = "", selfClose) => {
    if (!BLOCK_TAGS.has(tag.toLowerCase()) || /\sname=/.test(attrs))
      return match;
    const id = randomUUID();
    return `<${tag}${attrs} name="${id}" id="${id}"${selfClose}>`;
  });
}
function stripDangerous(html) {
  return html.replace(/<(script|iframe|object|embed|form|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/href="javascript:[^"]*"/gi, 'href="#"');
}
function visibleTextLength(html) {
  const text = html.replace(/<br\s*\/?>/gi, "").replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp|quot|#0?39|nbsp);/g, "x");
  return [...text].length;
}
function htmlToText(html) {
  return html.replace(/<br\s*\/?>/gi, `
`).replace(/<\/(p|h[1-6]|li|blockquote|pre|figure)>/gi, `
`).replace(/<h2[^>]*>/gi, "## ").replace(/<h3[^>]*>/gi, "### ").replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, `

`).trim();
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// src/cli.ts
var SORTS = ["popular", "hot", "new"];
var COMMANDS = {
  "auth login": {
    usage: "auth login [--timeout <sec>] [--browser <path to Chrome/Edge/Chromium>]",
    summary: "Open a browser, log in to note.com by hand, and save the session cookies",
    options: { timeout: { type: "string", default: "300" }, browser: { type: "string" } },
    async run({ values }) {
      const cookies = await browserLogin({
        timeoutSec: int(values.timeout, "timeout"),
        browser: typeof values.browser === "string" ? values.browser : undefined,
        isLoggedIn: async (c2) => {
          try {
            await currentUser(new NoteClient({ session: { cookies: c2, savedAt: "probe" } }));
            return true;
          } catch {
            return false;
          }
        }
      });
      return finishLogin(cookies);
    }
  },
  "auth import": {
    usage: "auth import [--cookie '<Cookie header>']   (or pipe the header via stdin)",
    summary: "Save a session from a Cookie header copied from browser DevTools",
    options: { cookie: { type: "string" } },
    async run({ values }) {
      const raw = typeof values.cookie === "string" ? values.cookie : await readStdin();
      const cookies = parseCookieHeader(raw.trim());
      if (!cookies._note_session_v5) {
        throw new CliError("INVALID_INPUT", "The cookie string must contain _note_session_v5.");
      }
      return finishLogin(cookies);
    }
  },
  "auth status": {
    usage: "auth status",
    summary: "Show whether the saved session is valid and which account it belongs to",
    async run({ client }) {
      const session = await loadSession();
      if (!session)
        return { loggedIn: false, sessionPath: sessionPath() };
      try {
        const me = await currentUser(client);
        return { loggedIn: true, urlname: me.urlname, nickname: me.nickname, userId: me.id, savedAt: session.savedAt };
      } catch (e) {
        if (e instanceof CliError && (e.code === "AUTH_ERROR" || e.code === "NOT_LOGGED_IN")) {
          return { loggedIn: false, reason: e.message, sessionPath: sessionPath() };
        }
        throw e;
      }
    }
  },
  "auth logout": {
    usage: "auth logout",
    summary: "Delete the saved session file",
    async run() {
      return { removed: await clearSession(), sessionPath: sessionPath() };
    }
  },
  "draft create": {
    usage: "draft create <file.md|-> [--title <title>] [--dry-run]",
    summary: "Create a new draft from Markdown (title: frontmatter `title:` or first `# H1`)",
    options: { title: { type: "string" }, "dry-run": { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const article = await loadArticle(positionals[0], values.title);
      if (values["dry-run"])
        return { dryRun: true, ...article };
      const draft = await createDraft(client, article.title);
      await saveDraft(client, draft.id, article);
      return { created: true, ...draft, title: article.title, bodyLength: article.bodyLength, warnings: article.warnings };
    }
  },
  "draft update": {
    usage: "draft update <id|key|url> <file.md|-> [--title <title>] [--dry-run]",
    summary: "Overwrite an existing draft's title and body with Markdown",
    options: { title: { type: "string" }, "dry-run": { type: "boolean" } },
    args: 2,
    async run({ values, positionals, client }) {
      const article = await loadArticle(positionals[1], values.title);
      if (values["dry-run"])
        return { dryRun: true, ...article };
      const { id, key } = await resolveNoteId(client, positionals[0]);
      await saveDraft(client, id, article);
      return {
        updated: true,
        id,
        key,
        editUrl: key ? editUrl(key) : null,
        title: article.title,
        bodyLength: article.bodyLength,
        warnings: article.warnings
      };
    }
  },
  "draft get": {
    usage: "draft get <key|url> [--html]",
    summary: "Read a draft (or your own article) as the editor sees it",
    options: { html: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const data = await getDraft(client, noteKey(positionals[0]));
      const draft = data?.note_draft ?? data;
      const html = draft?.body ?? data?.body ?? "";
      return {
        id: data?.id,
        key: data?.key,
        status: data?.status,
        title: draft?.name ?? data?.name,
        editUrl: data?.key ? editUrl(data.key) : null,
        ...values.html ? { bodyHtml: html } : { bodyText: htmlToText(html) }
      };
    }
  },
  "draft list": {
    usage: "draft list [--page <n>] [--status draft|published]",
    summary: "List your own articles (drafts and published) from the note list",
    options: { page: { type: "string", default: "1" }, status: { type: "string" } },
    async run({ values, client }) {
      const res = await myNotes(client, int(values.page, "page"));
      const items = values.status ? res.items.filter((n) => n.status === values.status) : res.items;
      return { page: int(values.page, "page"), isLastPage: res.isLastPage, count: items.length, notes: items };
    }
  },
  "draft delete": {
    usage: "draft delete <id|key|url> --yes",
    summary: "Delete a draft (drafts only; published articles are not affected)",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      if (!values.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the draft.");
      const { id, key } = await resolveNoteId(client, positionals[0]);
      await deleteDraft(client, id);
      return { deleted: true, id, key };
    }
  },
  search: {
    usage: "search <query> [--sort popular|hot|new] [--limit <n>] [--start <n>]",
    summary: "Search articles by keyword",
    options: {
      sort: { type: "string", default: "popular" },
      limit: { type: "string", default: "20" },
      start: { type: "string", default: "0" }
    },
    args: 1,
    async run({ values, positionals, client }) {
      const q2 = positionals.join(" ");
      const res = await searchNotes(client, q2, {
        sort: oneOf(values.sort, SORTS, "sort"),
        limit: int(values.limit, "limit"),
        start: int(values.start, "start")
      });
      return { query: q2, total: res.total, count: res.items.length, notes: res.items };
    }
  },
  hashtag: {
    usage: "hashtag <tag> [--order popular|hot|new] [--limit <n>] [--paid-only]",
    summary: "List articles for a hashtag",
    options: {
      order: { type: "string", default: "popular" },
      limit: { type: "string", default: "50" },
      "paid-only": { type: "boolean" }
    },
    args: 1,
    async run({ values, positionals, client }) {
      const res = await hashtagNotes(client, positionals[0], {
        order: oneOf(values.order, SORTS, "order"),
        limit: int(values.limit, "limit"),
        paidOnly: Boolean(values["paid-only"])
      });
      return { hashtag: positionals[0].replace(/^#/, ""), total: res.total, count: res.items.length, notes: res.items };
    }
  },
  user: {
    usage: "user <urlname> [--limit <n>]",
    summary: "Show a creator's profile and recent articles",
    options: { limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const urlname = positionals[0];
      const creator = await getCreator(client, urlname);
      const res = await creatorNotes(client, urlname, { limit: int(values.limit, "limit") });
      return {
        profile: {
          urlname: creator?.urlname,
          nickname: creator?.nickname,
          profile: creator?.profile,
          noteCount: creator?.noteCount,
          followerCount: creator?.followerCount,
          followingCount: creator?.followingCount
        },
        total: res.total,
        count: res.items.length,
        notes: res.items
      };
    }
  },
  note: {
    usage: "note <key|url> [--html]",
    summary: "Read a published article (summary + body text)",
    options: { html: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const data = await getNote(client, noteKey(positionals[0]));
      const body = data?.body ?? "";
      return {
        ...normalizeNote(data ?? {}),
        description: data?.description ?? null,
        canRead: data?.can_read ?? data?.canRead ?? null,
        ...values.html ? { bodyHtml: body } : { bodyText: htmlToText(body) }
      };
    }
  },
  "analyze search": {
    usage: "analyze search <query> [--sort popular|hot|new] [--limit <n>] [--top <n>]",
    summary: "Fetch search results and summarize likes, pricing, titles and timing",
    options: {
      sort: { type: "string", default: "popular" },
      limit: { type: "string", default: "100" },
      top: { type: "string", default: "10" }
    },
    args: 1,
    async run({ values, positionals, client }) {
      const q2 = positionals.join(" ");
      const res = await searchNotes(client, q2, {
        sort: oneOf(values.sort, SORTS, "sort"),
        limit: int(values.limit, "limit")
      });
      return { source: { type: "search", query: q2, sort: values.sort, total: res.total }, ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    }
  },
  "analyze hashtag": {
    usage: "analyze hashtag <tag> [--order popular|hot|new] [--limit <n>] [--top <n>]",
    summary: "Fetch a hashtag's articles and summarize them",
    options: {
      order: { type: "string", default: "popular" },
      limit: { type: "string", default: "100" },
      top: { type: "string", default: "10" }
    },
    args: 1,
    async run({ values, positionals, client }) {
      const res = await hashtagNotes(client, positionals[0], {
        order: oneOf(values.order, SORTS, "order"),
        limit: int(values.limit, "limit")
      });
      return { source: { type: "hashtag", hashtag: positionals[0], order: values.order, total: res.total }, ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    }
  },
  "analyze user": {
    usage: "analyze user <urlname> [--limit <n>] [--top <n>]",
    summary: "Summarize a creator's articles (yours or a competitor's)",
    options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" } },
    args: 1,
    async run({ values, positionals, client }) {
      const res = await creatorNotes(client, positionals[0], { limit: int(values.limit, "limit") });
      return { source: { type: "user", urlname: positionals[0], total: res.total }, ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    }
  },
  "stats pv": {
    usage: "stats pv [--filter all|daily|weekly|monthly] [--sort pv|like|comment] [--page <n>]",
    summary: "Your own page views / likes / comments per article (requires login)",
    options: {
      filter: { type: "string", default: "all" },
      sort: { type: "string", default: "pv" },
      page: { type: "string", default: "1" }
    },
    async run({ values, client }) {
      return statsPv(client, {
        filter: oneOf(values.filter, ["all", "daily", "weekly", "monthly"], "filter"),
        sort: oneOf(values.sort, ["pv", "like", "comment"], "sort"),
        page: int(values.page, "page")
      });
    }
  }
};
async function finishLogin(cookies) {
  const probe = new NoteClient({ session: { cookies, savedAt: new Date().toISOString() } });
  const me = await currentUser(probe);
  const path = await saveSession({ cookies, urlname: me.urlname, userId: me.id, savedAt: new Date().toISOString() });
  return { loggedIn: true, urlname: me.urlname, nickname: me.nickname, sessionPath: path };
}
async function loadArticle(file, titleOverride) {
  const source = file === "-" ? await readStdin() : await readFile3(file, "utf8").catch((e) => {
    throw new CliError("INVALID_INPUT", `Cannot read ${file}: ${e.message}`);
  });
  const parsed = parseArticle(source);
  const title = typeof titleOverride === "string" && titleOverride || parsed.title;
  if (!title)
    throw new CliError("INVALID_INPUT", "No title: add frontmatter `title:`, a leading `# Title`, or --title.");
  const { html, bodyLength, warnings } = markdownToNoteHtml(parsed.markdown);
  return { title, html, bodyLength, warnings };
}
function noteKey(input) {
  const m = input.match(/(?:^|\/)(n[0-9a-f]{12,})(?:[/?#]|$)/);
  return m ? m[1] : input;
}
function int(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new CliError("USAGE", `--${name} must be a non-negative integer.`);
  return n;
}
function oneOf(v, allowed, name) {
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw new CliError("USAGE", `--${name} must be one of: ${allowed.join(", ")}.`);
  }
  return v;
}
async function readStdin() {
  if (process.stdin.isTTY)
    throw new CliError("USAGE", "Expected input on stdin.");
  const chunks = [];
  for await (const c2 of process.stdin)
    chunks.push(c2);
  return Buffer.concat(chunks).toString("utf8");
}
function helpText() {
  const lines = [
    "note-cli \u2014 unofficial note.com CLI (JSON output)",
    "",
    "Usage: note-cli <command> [options]",
    "",
    ...Object.values(COMMANDS).map((c2) => `  ${c2.usage}
      ${c2.summary}`),
    "",
    "Env: NOTE_COOKIE (Cookie header, overrides saved session), NOTE_CLI_HOME, NOTE_CLI_INTERVAL_MS, NOTE_CLI_DEBUG"
  ];
  return lines.join(`
`);
}
function findCommand(argv) {
  const two = argv.slice(0, 2).join(" ");
  if (COMMANDS[two])
    return { name: two, cmd: COMMANDS[two], rest: argv.slice(2) };
  if (argv[0] && COMMANDS[argv[0]])
    return { name: argv[0], cmd: COMMANDS[argv[0]], rest: argv.slice(1) };
  return null;
}
async function main(argv, deps = {}) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(helpText());
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    const group = Object.values(COMMANDS).filter((c2) => c2.usage.startsWith(`${argv[0]} `));
    console.error(group.length ? group.map((c2) => `note-cli ${c2.usage}`).join(`
`) : `Unknown command: ${argv[0]}

${helpText()}`);
    return 2;
  }
  const { cmd, rest } = found;
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`note-cli ${cmd.usage}
  ${cmd.summary}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true });
    if (positionals.length < (cmd.args ?? 0))
      throw new CliError("USAGE", `Usage: note-cli ${cmd.usage}`);
    const client = deps.client ?? new NoteClient;
    const result = await cmd.run({ values, positionals, client });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, detail: e.detail } }, null, 2));
      return e.code === "USAGE" ? 2 : 1;
    }
    if (e.code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(`${e.message}
Usage: note-cli ${cmd.usage}`);
      return 2;
    }
    console.error(JSON.stringify({ error: { code: "UNEXPECTED", message: e.stack ?? String(e) } }, null, 2));
    return 1;
  }
}

// src/bin.ts
process.exitCode = await main(process.argv.slice(2));
