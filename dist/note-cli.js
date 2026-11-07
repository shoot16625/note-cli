#!/usr/bin/env bun
// @bun

// src/cli.ts
import { readFile as readFile4, stat as stat2 } from "fs/promises";
import { dirname as dirname2, resolve as resolve2 } from "path";
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
    return (await this.requestRaw(path, opts)).data;
  }
  async requestRaw(path, opts = {}) {
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
    if (opts.bearer)
      headers.Authorization = `Bearer ${opts.bearer}`;
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
    } else if (opts.form) {
      body = opts.form;
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
      const apiMessage = errorMessage(data);
      const code = res.status === 401 || res.status === 403 && !apiMessage ? "AUTH_ERROR" : res.status === 403 ? "FORBIDDEN" : res.status === 404 ? "NOT_FOUND" : res.status === 429 ? "RATE_LIMITED" : "API_ERROR";
      const hint = code === "AUTH_ERROR" ? " Session may be expired; run `note-cli auth login` again." : "";
      const suffix = apiMessage ? ` ${apiMessage}` : "";
      throw new CliError(code, `${method} ${url.pathname} -> HTTP ${res.status}.${suffix}${hint}`, {
        status: res.status,
        detail: typeof data === "string" ? data.slice(0, 500) : data
      });
    }
    return { status: res.status, headers: res.headers, data };
  }
  async postForm(url, form) {
    const target = new URL(url);
    if (target.protocol !== "https:")
      throw new CliError("API_ERROR", `Refusing to upload to a non-https URL: ${url}`);
    await this.throttle();
    if (process.env.NOTE_CLI_DEBUG)
      console.error(`[note-cli] POST ${target.origin}${target.pathname}`);
    let res;
    try {
      res = await this.fetchImpl(target, { method: "POST", body: form });
    } catch (e) {
      throw new CliError("NETWORK_ERROR", `Upload failed: ${e.message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CliError("API_ERROR", `Image upload to storage failed: HTTP ${res.status}.`, {
        status: res.status,
        detail: text.slice(0, 500)
      });
    }
    return res;
  }
  async download(url) {
    const target = new URL(url);
    if (target.protocol !== "https:")
      throw new CliError("API_ERROR", `Refusing to download from a non-https URL: ${url}`);
    await this.throttle();
    if (process.env.NOTE_CLI_DEBUG)
      console.error(`[note-cli] GET ${target.origin}${target.pathname}`);
    let res;
    try {
      res = await this.fetchImpl(target, { method: "GET", headers: { "User-Agent": USER_AGENT } });
    } catch (e) {
      throw new CliError("NETWORK_ERROR", `Download failed: ${e.message}`);
    }
    if (!res.ok)
      throw new CliError("API_ERROR", `Download of ${target.origin}${target.pathname} failed: HTTP ${res.status}.`, { status: res.status });
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
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
function errorMessage(data) {
  const d = data;
  const raw = [d?.error?.message, d?.message, typeof d?.data === "string" ? d.data : null].find((m) => typeof m === "string" && m.trim());
  if (!raw)
    return null;
  return raw.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

// src/images.ts
import { readFile as readFile2, stat } from "fs/promises";
import { basename, isAbsolute, resolve } from "path";
var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function sniffImageType(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71)
    return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  if (b.length >= 6 && b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56)
    return "image/gif";
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") {
    return "image/webp";
  }
  return null;
}
function isLocalImageRef(src) {
  const s = src.trim();
  if (!s || s.startsWith("//"))
    return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(s) || /^file:\/\//i.test(s);
}
function resolveImagePath(src, baseDir) {
  let s = src.trim();
  if (/^file:\/\//i.test(s))
    s = new URL(s).pathname;
  try {
    s = decodeURI(s);
  } catch {}
  return isAbsolute(s) ? s : resolve(baseDir, s);
}
async function readImage(path) {
  const info = await stat(path).catch((e) => {
    throw new CliError("INVALID_INPUT", `Cannot read image ${path}: ${e.message}`);
  });
  if (!info.isFile())
    throw new CliError("INVALID_INPUT", `Not a file: ${path}`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new CliError("INVALID_INPUT", `Image ${path} is ${(info.size / 1024 / 1024).toFixed(1)} MB; note accepts up to 10 MB.`);
  }
  const bytes = new Uint8Array(await readFile2(path));
  const mimeType = sniffImageType(bytes);
  if (!mimeType)
    throw new CliError("INVALID_INPUT", `Unsupported image type: ${path} (use PNG, JPEG, GIF or WebP).`);
  return { path, filename: basename(path), mimeType, bytes };
}
var EYECATCH_RATIO = 1280 / 670;
function imageSize(bytes) {
  const type = sniffImageType(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === "image/png")
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (type === "image/gif")
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (type === "image/webp") {
      const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (chunk === "VP8X") {
        const w = 1 + (bytes[24] | bytes[25] << 8 | bytes[26] << 16);
        const h = 1 + (bytes[27] | bytes[28] << 8 | bytes[29] << 16);
        return { width: w, height: h };
      }
      if (chunk === "VP8 ")
        return { width: dv.getUint16(26, true) & 16383, height: dv.getUint16(28, true) & 16383 };
      if (chunk === "VP8L") {
        const b = dv.getUint32(21, true);
        return { width: (b & 16383) + 1, height: (b >> 14 & 16383) + 1 };
      }
      return null;
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 255)
          return null;
        const marker = bytes[i + 1];
        const len = dv.getUint16(i + 2);
        if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
          return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}
function eyecatchRatioWarning(image) {
  const size = imageSize(image.bytes);
  if (!size || !size.height)
    return null;
  const ratio = size.width / size.height;
  if (Math.abs(ratio - EYECATCH_RATIO) / EYECATCH_RATIO <= 0.01)
    return null;
  return `Eyecatch ${image.filename} is ${size.width}x${size.height}; note requires a 1280:670 aspect ratio (e.g. 1280x670) and will likely reject it.`;
}
var STOCK_PREFIX = "stock:";
var STOCK_HOST = "assets.st-note.com";
function stockPhotoRef(stockPhotoImageId, url) {
  return `${STOCK_PREFIX}${stockPhotoImageId}:${url}`;
}
function isStockPhotoRef(value) {
  return value.trim().startsWith(STOCK_PREFIX);
}
function parseStockPhotoRef(value) {
  const m = /^stock:(\d+):(https:\/\/\S+)$/.exec(value.trim());
  const url = m ? URL.parse(m[2]) : null;
  if (!m || !url || url.hostname !== STOCK_HOST) {
    throw new CliError("INVALID_INPUT", `Not a gallery photo reference: ${value}. Use the \`eyecatch\` value printed by \`note-cli photo search\` (stock:<id>:https://${STOCK_HOST}/...).`);
  }
  url.search = "";
  return { stockPhotoImageId: Number(m[1]), url: url.toString() };
}
function stockPhotoCropUrl(url) {
  const u = new URL(url);
  u.search = new URLSearchParams({ width: "1280", height: "670", fit: "crop", format: "jpeg", quality: "95" }).toString();
  return u.toString();
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
  return { title, markdown: obsidianToMarkdown(markdown.replace(/^\n+/, "")), frontmatter };
}
function markdownToNoteHtml(markdown, opts = {}) {
  const warnings = [];
  const images = opts.images ?? new Map;
  const embeds = opts.embeds ?? new Map;
  const marked = new Y({ gfm: true, breaks: true });
  const uploaded = (t) => t.type === "image" && images.has(t.href);
  marked.use({
    renderer: {
      paragraph(token) {
        const lone = loneLink(token);
        const embed = lone ? embeds.get(lone.href.trim()) : undefined;
        if (embed)
          return embedFigure(embed);
        if (!token.tokens.some(uploaded))
          return `<p>${this.parser.parseInline(token.tokens)}</p>
`;
        let out = "";
        let run = [];
        const flush = () => {
          const inner = this.parser.parseInline(run).replace(/^(\s|<br>)+|(\s|<br>)+$/g, "");
          if (inner)
            out += `<p>${inner}</p>
`;
          run = [];
        };
        for (const t of token.tokens) {
          if (uploaded(t)) {
            flush();
            out += figure(images.get(t.href), t);
          } else {
            run.push(t);
          }
        }
        flush();
        return out;
      },
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
      link(token) {
        const inner = this.parser.parseInline(token.tokens);
        const href = safeHref(token.href);
        if (!href) {
          warnings.push(`Link "${token.href}" was dropped (only http, https and mailto links are allowed).`);
          return inner;
        }
        return `<a href="${escapeAttr(href)}">${inner}</a>`;
      },
      image(token) {
        if (images.has(token.href)) {
          warnings.push(`Image "${token.href}" is inside a list item; note may not show it there. Put images on their own line.`);
          return figure(images.get(token.href), token);
        }
        const label = escapeHtml(token.text || token.href);
        const href = safeHref(token.href);
        warnings.push(href ? `Image "${token.href}" is a remote URL and was not uploaded; replaced with a link. Save it locally and reference the file to embed it.` : `Image "${token.href}" was not uploaded; replaced with its alt text.`);
        return href ? `<a href="${escapeAttr(href)}">${label}</a>` : label;
      },
      table(token) {
        warnings.push("Tables are not supported by note.com; rendered as a code block.");
        const rows = [token.header, ...token.rows].map((row) => row.map((cell) => cell.text).join(" | "));
        return `<pre><code>${escapeHtml(rows.join(`
`))}</code></pre>
`;
      },
      html(token) {
        if (PAYWALL_MARKER.test(token.raw.trim()))
          return `${PAYWALL_LINE}
`;
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
var PAYWALL_MARKER = /^<!--\s*paywall\s*-->$/i;
var PAYWALL_LINE = "<paywall-line></paywall-line>";
function figure(src, token) {
  const caption = token.title ? `<figcaption>${escapeHtml(token.title)}</figcaption>` : "";
  return `<figure><img src="${escapeAttr(src)}" alt="${escapeAttr(token.text ?? "")}" width="620" height="auto">${caption}</figure>
`;
}
function loneLink(token) {
  const parts = token.tokens.filter((t) => !(t.type === "text" && !t.raw.trim()) && t.type !== "br");
  return parts.length === 1 && parts[0].type === "link" ? parts[0] : null;
}
function embedFigure(e) {
  const attrs = [
    e.url ? `data-src="${escapeAttr(e.url)}"` : "",
    e.service === "attachment" ? "" : `data-identifier="${escapeAttr(e.identifier ?? "null")}"`,
    `embedded-service="${escapeAttr(e.service)}"`,
    `embedded-content-key="${escapeAttr(e.key)}"`
  ].filter(Boolean);
  return `<figure ${attrs.join(" ")}>${e.service === "attachment" ? e.html ?? "" : ""}</figure>
`;
}
function blockLinks(markdown) {
  const urls = new Set;
  const files = new Set;
  const m = new Y({ gfm: true, breaks: true });
  for (const t of m.lexer(markdown)) {
    if (t.type !== "paragraph")
      continue;
    const link = loneLink(t);
    if (!link)
      continue;
    const href = link.href.trim();
    if (/^https?:\/\//i.test(href)) {
      if (link.text.trim() === href || link.text.trim() === link.raw.trim().replace(/^<|>$/g, ""))
        urls.add(href);
    } else if (href && !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) {
      files.add(href);
    } else if (/^file:\/\//i.test(href)) {
      files.add(href);
    }
  }
  return { urls: [...urls], files: [...files] };
}
function obsidianToMarkdown(markdown) {
  let inFence = null;
  return markdown.split(`
`).map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence)
        inFence = fence[1][0];
      else if (fence[1][0] === inFence)
        inFence = null;
      return line;
    }
    if (inFence)
      return line;
    return line.split(/(`+[^`]*`+)/).map((part, i) => i % 2 ? part : part.replace(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_2, src, alt = "") => {
      const target = src.trim();
      return /^\d+(x\d+)?$/.test(alt.trim()) ? `![](<${target}>)` : `![${alt.trim()}](<${target}>)`;
    }).replace(/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_2, page, label) => (label ?? page).trim()).replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, "**$1**")).join("");
  }).join(`
`);
}
function imageRefs(markdown) {
  const refs = new Set;
  const m = new Y({ gfm: true, breaks: true });
  m.walkTokens(m.lexer(markdown), (t) => {
    if (t.type === "image")
      refs.add(t.href);
  });
  return [...refs];
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
function safeHref(href) {
  const trimmed = href.trim();
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}
function stripDangerous(html) {
  return html.replace(/<(script|iframe|object|embed|form|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "");
}
function visibleTextLength(html) {
  const text = html.replace(/<figure\b[^>]*\sembedded-service="[^"]*"[^>]*>[\s\S]*?<\/figure>/gi, "").replace(/<paywall-line[^>]*>\s*<\/paywall-line>/gi, "").replace(/<br\s*\/?>/gi, "").replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp|quot|#0?39|nbsp);/g, "x");
  return [...text].length;
}
function htmlToText(html) {
  return html.replace(/<figure\b[^>]*\sembedded-service="([^"]*)"[^>]*>([\s\S]*?)<\/figure>/gi, (tag, service, inner) => {
    if (service === "attachment") {
      const name = inner.match(/file-widget__filename[^>]*>([^<]*)</)?.[1] ?? "file";
      return `
[attachment: ${name}]
`;
    }
    const src = tag.match(/\sdata-src="([^"]*)"/)?.[1];
    return src && src !== "null" ? `
${src}
` : `
[${service} embed]
`;
  }).replace(/<img\b[^>]*>/gi, (tag) => {
    const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1] ?? "";
    return `
![${attr("alt")}](${attr("src")})
`;
  }).replace(/<figcaption[^>]*>/gi, "").replace(/<paywall-line[^>]*>\s*<\/paywall-line>/gi, `
----- paywall -----
`).replace(/<br\s*\/?>/gi, `
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

// src/normalize.ts
var EXCERPT_MAX_CHARS = 200;
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null)
      return obj[k];
  }
  return;
}
function toNumber(v) {
  const n = Number(v);
  return v === undefined || v === null || Number.isNaN(n) ? null : n;
}
function hashtagsOf(raw) {
  const list = pick(raw, "hashtag_notes", "hashtagNotes", "hashtags");
  if (!Array.isArray(list))
    return [];
  return list.map((h) => h?.hashtag?.name ?? h?.name ?? (typeof h === "string" ? h : null)).filter((h) => typeof h === "string" && h.length > 0).map((h) => h.replace(/^#/, ""));
}
function makeExcerpt(raw, max = EXCERPT_MAX_CHARS) {
  const source = pick(raw, "description") || pick(raw, "body");
  if (typeof source !== "string" || !source.trim())
    return null;
  const text = htmlToText(source).replace(/\s+/g, " ").trim();
  if (!text)
    return null;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}\u2026` : text;
}
function tryNormalizeNote(raw) {
  if (!raw || typeof raw !== "object")
    return "row is not an object";
  const r = raw;
  const key = pick(r, "key");
  if (typeof key !== "string" || !key)
    return "missing key";
  const title = pick(r, "name");
  if (typeof title !== "string")
    return `missing title (key ${key})`;
  const user = r.user ?? {};
  const urlname = typeof user.urlname === "string" ? user.urlname : null;
  const price = toNumber(pick(r, "price")) ?? 0;
  return {
    id: toNumber(pick(r, "id")),
    key,
    title,
    url: pick(r, "noteUrl", "note_url") ?? (urlname ? `https://note.com/${urlname}/n/${key}` : `https://note.com/n/${key}`),
    status: pick(r, "status") ?? null,
    author: { urlname, nickname: pick(user, "nickname", "name") ?? null },
    likeCount: toNumber(pick(r, "like_count", "likeCount")) ?? 0,
    commentCount: toNumber(pick(r, "comment_count", "commentCount")),
    price,
    isPaid: price > 0,
    publishAt: pick(r, "publish_at", "publishAt") ?? null,
    hashtags: hashtagsOf(r),
    excerpt: makeExcerpt(r),
    eyecatch: pick(r, "eyecatch", "eyecatch_url", "eyecatchUrl") || null,
    imageCount: toNumber(pick(r, "image_count", "imageCount"))
  };
}
function normalizeNotes(rows, offset = 0) {
  return normalizeRows(rows, tryNormalizeNote, offset);
}
function normalizeRows(rows, normalize, offset = 0) {
  if (!Array.isArray(rows)) {
    return { items: [], skipped: rows === undefined || rows === null ? [] : [{ index: offset, reason: "list is not an array" }] };
  }
  const items = [];
  const skipped = [];
  rows.forEach((row, i) => {
    const n = normalize(row);
    if (typeof n === "string")
      skipped.push({ index: offset + i, reason: n });
    else
      items.push(n);
  });
  return { items, skipped };
}
var str = (v) => typeof v === "string" && v ? v : null;
function tryNormalizeUser(raw) {
  if (!raw || typeof raw !== "object")
    return "row is not an object";
  const r = raw;
  const urlname = str(r.urlname);
  if (!urlname)
    return "missing urlname";
  const profile = str(r.profile);
  return {
    id: toNumber(r.id),
    urlname,
    nickname: str(pick(r, "nickname", "name")),
    url: `https://note.com/${urlname}`,
    profile: profile ? truncate(profile.replace(/\s+/g, " ").trim(), EXCERPT_MAX_CHARS) : null,
    followerCount: toNumber(pick(r, "follower_count", "followerCount")),
    followingCount: toNumber(pick(r, "following_count", "followingCount")),
    isOfficial: typeof r.is_official === "boolean" ? r.is_official : null
  };
}
function tryNormalizeMagazine(raw) {
  if (!raw || typeof raw !== "object")
    return "row is not an object";
  const r = raw;
  const key = str(r.key);
  if (!key)
    return "missing key";
  const name = pick(r, "name");
  if (typeof name !== "string")
    return `missing name (key ${key})`;
  const user = r.user ?? {};
  const urlname = str(user.urlname);
  const price = toNumber(r.price) ?? 0;
  const description = str(r.description);
  return {
    id: toNumber(r.id),
    key,
    name,
    url: str(pick(r, "magazine_url", "magazineUrl")) ?? (urlname ? `https://note.com/${urlname}/m/${key}` : `https://note.com/m/${key}`),
    description: description ? truncate(description, EXCERPT_MAX_CHARS) : null,
    author: { urlname, nickname: str(pick(user, "nickname", "name")) },
    price,
    isPaid: price > 0,
    noteCount: toNumber(pick(r, "note_count", "noteCount")),
    updatedAt: str(pick(r, "updated_at", "updatedAt"))
  };
}
function tryNormalizeHashtag(raw) {
  if (!raw || typeof raw !== "object")
    return "row is not an object";
  const r = raw;
  const full = str(r.name);
  if (!full)
    return "missing name";
  const name = full.replace(/^#/, "");
  return { name, count: toNumber(r.count), url: `https://note.com/hashtag/${encodeURIComponent(name)}` };
}
function tryNormalizeLike(raw) {
  if (!raw || typeof raw !== "object")
    return "row is not an object";
  const r = raw;
  const user = r.user;
  if (!user || typeof user !== "object")
    return "missing user";
  return {
    likedAt: str(pick(r, "created_at", "createdAt")),
    user: {
      urlname: str(user.urlname),
      nickname: str(pick(user, "nickname", "name")),
      followerCount: toNumber(pick(user, "follower_count", "followerCount"))
    }
  };
}
function commentText(node) {
  if (!node || typeof node !== "object")
    return typeof node === "string" ? node : "";
  if (node.type === "text")
    return typeof node.value === "string" ? node.value : "";
  const children = Array.isArray(node.children) ? node.children : [];
  const inner = children.map(commentText).join("");
  if (node.tag_name === "br")
    return `
`;
  return node.tag_name === "p" ? `${inner}
` : inner;
}
function tryNormalizeComment(raw) {
  if (!raw || typeof raw !== "object")
    return "row is not an object";
  const r = raw;
  const key = str(r.key);
  if (!key)
    return "missing key";
  const user = r.user ?? {};
  const text = typeof r.comment === "string" ? r.comment : commentText(r.comment);
  return {
    key,
    text: text.trim(),
    author: { urlname: str(user.urlname), nickname: str(pick(user, "nickname", "name")) },
    likeCount: toNumber(pick(r, "like_count", "likeCount")) ?? 0,
    replyCount: toNumber(pick(r, "reply_count", "replyCount")) ?? 0,
    creatorReplied: typeof r.is_creator_replied === "boolean" ? r.is_creator_replied : null,
    createdAt: str(pick(r, "created_at", "createdAt"))
  };
}
function tryNormalizeContest(raw) {
  if (!raw || typeof raw !== "object")
    return "row is not an object";
  const r = raw;
  const name = str(r.name);
  if (!name)
    return "missing name";
  const note = r.note && typeof r.note === "object" ? r.note : null;
  const noteUrl = note ? str(pick(note, "noteUrl", "note_url")) ?? (str(note.key) && str(note.user?.urlname) ? `https://note.com/${note.user.urlname}/n/${note.key}` : null) : null;
  return {
    id: toNumber(r.id),
    name,
    type: str(r.type),
    state: str(r.state),
    hashtag: str(r.hashtag?.name)?.replace(/^#/, "") ?? null,
    sponsor: str(r.sponsor),
    openAt: str(r.openAt),
    closeAt: str(r.closeAt)?.startsWith("2999") ? null : str(r.closeAt),
    noteUrl
  };
}
function truncate(s, max) {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join("")}\u2026` : s;
}

// src/api.ts
async function paginate(limit, pageSize, fetchBatch, startOffset = 0, normalize = tryNormalizeNote) {
  const items = [];
  const skipped = [];
  let total = null;
  let exhausted = false;
  let offset = startOffset;
  for (let pageIndex = 0;items.length < limit; pageIndex++) {
    const size = Math.min(pageSize, limit - items.length);
    const batch = await fetchBatch(offset, size, pageIndex);
    const rowCount = Array.isArray(batch.rows) ? batch.rows.length : 0;
    const normalized = normalizeRows(batch.rows, normalize, offset);
    items.push(...normalized.items);
    skipped.push(...normalized.skipped);
    total = batch.total ?? total;
    offset += rowCount;
    if (rowCount === 0 || batch.isLastPage === true || total !== null && offset >= total || batch.isLastPage === null && rowCount < size) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted, skipped };
}
var num = (v) => typeof v === "number" ? v : null;
var bool = (v) => typeof v === "boolean" ? v : null;
async function searchNotes(client, q2, opts = {}) {
  return paginate(opts.limit ?? 20, 20, async (start, size) => {
    const res = await client.request("/v3/searches", {
      auth: "optional",
      query: { context: "note", q: q2, size, start, sort: opts.sort ?? "popular" }
    });
    const notes = res?.data?.notes ?? {};
    return { rows: notes.contents, total: num(notes.total_count), isLastPage: bool(notes.is_last_page) };
  }, opts.start ?? 0);
}
var SEARCH_NORMALIZERS = {
  user: tryNormalizeUser,
  magazine: tryNormalizeMagazine,
  hashtag: tryNormalizeHashtag
};
async function searchOther(client, type, q2, opts = {}) {
  const bucket = { user: "users", magazine: "magazines", hashtag: "hashtags" }[type];
  return paginate(opts.limit ?? 20, 20, async (start, size) => {
    const res = await client.request("/v3/searches", { auth: "optional", query: { context: type, q: q2, size, start } });
    const list = res?.data?.[bucket] ?? {};
    return { rows: list.contents, total: num(list.total_count), isLastPage: bool(list.is_last_page) };
  }, opts.start ?? 0, SEARCH_NORMALIZERS[type]);
}
async function hashtagInfo(client, tag) {
  const res = await client.request(`/v2/hashtags/${encodeURIComponent(tag)}`, { auth: "optional" });
  const data = res?.data;
  if (!data || typeof data !== "object")
    return null;
  return {
    name: String(data.name ?? tag).replace(/^#/, ""),
    count: num(data.count),
    related: normalizeRows(data.relatedHashtags ?? data.related_hashtags, tryNormalizeHashtag).items
  };
}
async function hashtagNotes(client, tag, opts = {}) {
  return paginate(opts.limit ?? 50, 50, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v3/hashtags/${encodeURIComponent(tag)}/notes`, {
      auth: "optional",
      query: { order: opts.order ?? "popular", page: pageIndex + 1, paid_only: opts.paidOnly ? "true" : undefined }
    });
    const data = res?.data ?? {};
    return { rows: data.notes, total: num(data.count), isLastPage: bool(data.is_last_page) ?? false };
  });
}
async function creatorNotes(client, urlname, opts = {}) {
  return paginate(opts.limit ?? 50, 50, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v2/creators/${encodeURIComponent(urlname)}/contents`, {
      auth: "optional",
      query: { kind: "note", page: pageIndex + 1 }
    });
    const data = res?.data ?? {};
    return { rows: data.contents, total: num(data.totalCount), isLastPage: bool(data.isLastPage) ?? false };
  });
}
async function getCreator(client, urlname) {
  const res = await client.request(`/v2/creators/${encodeURIComponent(urlname)}`, { auth: "optional" });
  return res?.data;
}
async function getNote(client, key) {
  const res = await client.request(`/v3/notes/${encodeURIComponent(key)}`, { auth: "optional" });
  return res?.data;
}
async function noteLikes(client, key, opts = {}) {
  return paginate(opts.limit ?? 50, 50, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v3/notes/${encodeURIComponent(key)}/likes`, {
      auth: "optional",
      query: { page: pageIndex + 1 }
    });
    return {
      rows: res?.data?.likes,
      total: num(res?.data?.extra_fields?.like_count),
      isLastPage: bool(res?.is_last_page ?? res?.data?.is_last_page) ?? false
    };
  }, 0, tryNormalizeLike);
}
async function noteComments(client, key, opts = {}) {
  return paginate(opts.limit ?? 50, 20, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v3/notes/${encodeURIComponent(key)}/note_comments`, {
      auth: "optional",
      query: { page: pageIndex + 1 }
    });
    return {
      rows: res?.data,
      total: num(res?.total_count),
      isLastPage: res && "next_page" in res ? res.next_page === null : false
    };
  }, 0, tryNormalizeComment);
}
async function getMagazine(client, key) {
  const res = await client.request(`/v1/magazines/${encodeURIComponent(key)}`, { auth: "optional" });
  const m = tryNormalizeMagazine(res?.data);
  if (typeof m === "string")
    throw new CliError("API_ERROR", `Unexpected response for magazine ${key}: ${m}.`);
  return m;
}
async function magazineNotes(client, key, opts = {}) {
  return paginate(opts.limit ?? 20, 20, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v1/layout/magazine/${encodeURIComponent(key)}/section`, {
      auth: "optional",
      query: { page: pageIndex + 1 }
    });
    const section = res?.data?.section ?? {};
    return { rows: section.contents, total: null, isLastPage: bool(section.is_last_page) ?? false };
  });
}
async function categories(client) {
  const res = await client.request("/v2/categories", { auth: "optional" });
  const list = res?.data?.categories;
  if (!Array.isArray(list))
    return [];
  const out = [{ id: null, name: "\u6CE8\u76EE (featured)", slug: "featured" }];
  for (const c2 of list) {
    if (typeof c2?.engName === "string" && typeof c2?.endpoint === "string" && c2.endpoint.includes("/v1/categories/")) {
      out.push({ id: num(c2.id), name: String(c2.name ?? c2.engName), slug: c2.engName });
    }
  }
  return out;
}
async function categoryNotes(client, slug, opts = {}) {
  return paginate(opts.limit ?? 20, 10, async (_offset, _size, pageIndex) => {
    const res = slug === "featured" ? await client.request("/v3/notes/top_articles", { auth: "optional", query: { page: pageIndex + 1 } }) : await client.request(`/v1/categories/${encodeURIComponent(slug)}`, {
      auth: "optional",
      query: { note_intro_only: "true", sort: opts.sort ?? "new", page: pageIndex + 1 }
    });
    const data = res?.data ?? {};
    return { rows: data.notes ?? data.articles, total: null, isLastPage: bool(data.last_page) ?? false };
  });
}
async function contests(client) {
  const res = await client.request("/v2/contests", { auth: "optional" });
  return normalizeRows(res?.data?.contests, tryNormalizeContest);
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
async function resolveNoteId(client, ref) {
  if ("id" in ref)
    return { id: ref.id, key: null };
  const data = await getDraft(client, ref.key);
  if (!data?.id)
    throw new CliError("NOT_FOUND", `Could not resolve note id for "${ref.key}".`);
  return { id: Number(data.id), key: data.key ?? ref.key };
}
async function myNotes(client, page = 1) {
  const res = await client.request("/v2/note_list/contents", { auth: "required", query: { page } });
  const data = res?.data ?? {};
  const list = data.notes ?? data.contents ?? (Array.isArray(data) ? data : undefined);
  const { items, skipped } = normalizeNotes(list);
  return { items, skipped, isLastPage: bool(data.isLastPage) ?? bool(data.is_last_page) };
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
async function saveDraft(client, id, body, opts = {}) {
  const res = await client.request("/v1/text_notes/draft_save", {
    method: "POST",
    auth: "required",
    editor: true,
    query: { id },
    json: {
      name: body.title,
      body: body.html,
      body_length: body.bodyLength,
      index: false,
      is_lead_form: false,
      ...opts.stockPhotoImageId ? { stock_photo_image_id: opts.stockPhotoImageId } : {}
    }
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
async function uploadImage(client, image) {
  const presignForm = new FormData;
  presignForm.append("filename", image.filename);
  const res = await client.request("/v3/images/upload/presigned_post", {
    method: "POST",
    auth: "required",
    editor: true,
    form: presignForm
  });
  const data = res?.data ?? {};
  const url = data.url;
  const action = data.action;
  const post = data.post;
  if (typeof url !== "string" || typeof action !== "string" || !post || typeof post !== "object") {
    throw new CliError("API_ERROR", "Image upload: presigned_post response was missing url/action/post.", { detail: res });
  }
  const s3Form = new FormData;
  for (const [k, v] of Object.entries(post)) {
    if (v !== null && v !== undefined && v !== "")
      s3Form.append(k, String(v));
  }
  s3Form.append("file", new Blob([image.bytes], { type: image.mimeType }), image.filename);
  await client.postForm(action, s3Form);
  return { url };
}
async function setEyecatch(client, noteId, image) {
  const form = new FormData;
  form.append("note_id", String(noteId));
  form.append("file", new Blob([image.bytes], { type: image.mimeType }), image.filename);
  const res = await client.request("/v1/image_upload/note_eyecatch", {
    method: "POST",
    auth: "required",
    editor: true,
    form
  });
  if (res?.error) {
    const message = typeof res.error.message === "string" ? res.error.message : JSON.stringify(res.error);
    throw new CliError("API_ERROR", `Eyecatch was rejected: ${message}`, { detail: res });
  }
  const d = res?.data ?? res;
  const url = d?.url ?? d?.eyecatch_url ?? d?.eyecatch ?? null;
  return { url: typeof url === "string" ? url : null };
}
async function searchStockPhotos(client, opts) {
  const res = await client.request("/v2/stock_photo_images", {
    auth: "required",
    query: { page: opts.page, query: opts.query, size: opts.size, public_domain_only: opts.publicDomainOnly }
  });
  const d = res?.data ?? {};
  const rows = Array.isArray(d.contents) ? d.contents : [];
  const items = [];
  const skipped = [];
  for (const [index, x2] of rows.entries()) {
    const id = Number(x2?.stockPhotoImageId ?? x2?.stock_photo_image_id);
    const original = x2?.url?.original;
    if (!Number.isInteger(id) || id <= 0 || typeof original !== "string") {
      skipped.push({ index, reason: "missing stockPhotoImageId or url.original" });
      continue;
    }
    const pd = (x2.isPublicDomainImage ?? x2.is_public_domain_image) === true;
    const art = x2.publicDomainImageDetail ?? x2.public_domain_image_detail ?? {};
    const artwork = pd ? { title: art.title ?? null, artistName: art.artistName ?? art.artist_name ?? null, museumName: art.museumName ?? art.museum_name ?? null } : null;
    const creator = !pd && x2.user?.urlname ? { urlname: String(x2.user.urlname), nickname: x2.user.nickname ?? null } : null;
    items.push({
      eyecatch: stockPhotoRef(id, original.split("?")[0]),
      stockPhotoImageId: id,
      thumbnailUrl: x2.url.stockPhotoThumb ?? x2.url.stock_photo_thumb ?? x2.url.imageUrl ?? null,
      originalUrl: original,
      width: typeof x2.size?.width === "number" ? x2.size.width : null,
      height: typeof x2.size?.height === "number" ? x2.size.height : null,
      keywords: Array.isArray(x2.keywords) ? x2.keywords.map((k) => k?.text).filter((t) => typeof t === "string") : [],
      credit: artwork ? [artwork.artistName, artwork.museumName].filter(Boolean).join(" / ") || null : creator?.urlname ?? null,
      creator,
      artwork,
      sourceNote: !pd && x2.note?.key ? { key: String(x2.note.key), title: x2.note.name ?? null } : null
    });
  }
  return { items, isLastPage: typeof d.isLastPage === "boolean" ? d.isLastPage : d.is_last_page ?? null, skipped };
}
async function downloadStockPhoto(client, ref) {
  const { bytes } = await client.download(stockPhotoCropUrl(ref.url));
  const mimeType = sniffImageType(bytes);
  if (!mimeType)
    throw new CliError("API_ERROR", `The gallery photo ${ref.url} did not download as an image.`);
  return { path: ref.url, filename: `stock-${ref.stockPhotoImageId}.jpg`, mimeType, bytes, stockPhotoImageId: ref.stockPhotoImageId };
}
var write = (client, path, method, json) => client.request(path, { method, auth: "required", ...json !== undefined ? { json } : {} });
async function likeNote(client, key, like) {
  const res = await write(client, `/v3/notes/${encodeURIComponent(key)}/likes`, like ? "POST" : "DELETE", like ? {} : undefined);
  return res?.data ?? res;
}
function commentAst(text) {
  return {
    type: "root",
    children: text.split(/\n{2,}/).map((para) => ({
      type: "element",
      tag_name: "p",
      children: [{ type: "text", value: para }]
    }))
  };
}
async function postComment(client, key, text, opts = {}) {
  const res = await write(client, `/v3/notes/${encodeURIComponent(key)}/note_comments`, "POST", {
    comment: commentAst(text),
    ...opts.replyTo ? { parent_key: opts.replyTo } : {}
  });
  if (res?.error)
    throw new CliError("API_ERROR", `Comment was rejected: ${res.error.message ?? JSON.stringify(res.error)}`, { detail: res });
  const c2 = tryNormalizeComment(res?.data ?? res);
  if (typeof c2 === "string")
    throw new CliError("API_ERROR", `Comment was posted but the response was unexpected: ${c2}.`, { detail: res });
  return c2;
}
async function deleteComment(client, key, commentKey) {
  await write(client, `/v3/notes/${encodeURIComponent(key)}/note_comments/${encodeURIComponent(commentKey)}`, "DELETE");
}
async function followUser(client, userKey, follow) {
  const res = await write(client, `/v3/users/${encodeURIComponent(userKey)}/following`, follow ? "POST" : "DELETE", follow ? {} : undefined);
  return res?.data ?? res ?? null;
}
async function changeToDraft(client, key) {
  const res = await write(client, `/v2/notes/${encodeURIComponent(key)}/change_status`, "POST", { status: "draft" });
  if (res?.error)
    throw new CliError("API_ERROR", `Could not change ${key} to a draft: ${res.error.message ?? JSON.stringify(res.error)}`, { detail: res });
  return res?.data ?? res;
}
async function myMagazines(client, noteKey) {
  const res = await client.request("/v1/my/magazines", { auth: "required", query: { note_key: noteKey } });
  const list = res?.data?.magazines;
  if (!Array.isArray(list))
    return [];
  return list.filter((m) => typeof m?.key === "string").map((m) => ({
    id: num(m.id),
    key: m.key,
    name: String(m.name ?? ""),
    status: typeof m.status === "string" ? m.status : null,
    noteCount: num(m.note_count),
    includesNote: bool(m.selected ?? m.is_added ?? m.included)
  }));
}
async function addToMagazine(client, magazineKey, noteKey, add) {
  const base = `/v1/our/magazines/${encodeURIComponent(magazineKey)}/notes`;
  const res = add ? await write(client, base, "POST", { note_key: noteKey }) : await write(client, `${base}/${encodeURIComponent(noteKey)}`, "DELETE");
  if (res?.error)
    throw new CliError("API_ERROR", `Magazine update failed: ${res.error.message ?? JSON.stringify(res.error)}`, { detail: res });
  return res?.data ?? res;
}
async function reservedNotes(client) {
  const res = await client.request("/v3/notes/reserved", { auth: "required" });
  return normalizeRows(res?.data, tryNormalizeNote);
}
async function noticeCounts(client) {
  const res = await client.request("/v3/notice_counts", { auth: "required" });
  const d = res?.data ?? {};
  return { notices: num(d.unread_notice_count), infoNotices: num(d.unread_info_notice_count), messages: num(d.unread_dm_count) };
}
async function membershipPlans(client) {
  const res = await client.request("/v2/circle/plans", { auth: "required" });
  const plans = res?.data?.circlePlans ?? res?.data?.circle_plans;
  return Array.isArray(plans) ? plans : [];
}
async function membershipSummaries(client) {
  const res = await client.request("/v2/circle/memberships/summaries", { auth: "required" });
  const d = res?.data ?? {};
  return { total: num(d.totalCount ?? d.total_count), items: Array.isArray(d.summaries) ? d.summaries : [] };
}
async function membershipAccess(client) {
  const res = await client.request("/v3/memberships/circle_permissions", { auth: "required" });
  const rows = Array.isArray(res?.data) ? res.data : [];
  return rows.filter((r) => typeof r?.circle?.key === "string").map((r) => ({
    circle: { key: r.circle.key, name: r.circle.name ?? null },
    plans: (Array.isArray(r.circle_plans) ? r.circle_plans : []).filter((p) => typeof p?.key === "string").map((p) => ({ key: p.key, name: p.name ?? null }))
  }));
}
var GRAPHQL_URL = "https://graphql.note.com/graphql";
async function graphql(client, query, variables) {
  const auth = await client.requestRaw("/v3/graphql/auth", { method: "POST", auth: "required" });
  const token = auth.headers.getSetCookie().map((c2) => c2.match(/^note_gql_auth_token=([^;]+)/)?.[1]).find(Boolean);
  if (!token)
    throw new CliError("AUTH_ERROR", "note did not issue a GraphQL token; run `note-cli auth login` again.");
  const res = await client.request(GRAPHQL_URL, { method: "POST", json: { query, variables }, bearer: token });
  if (Array.isArray(res?.errors) && res.errors.length) {
    throw new CliError("API_ERROR", `GraphQL error: ${res.errors.map((e) => e?.message).join("; ")}`, { detail: res.errors });
  }
  return res?.data;
}
var DASHBOARD_PERIODS = {
  "7d": "LAST_7_DAYS",
  "28d": "LAST_28_DAYS",
  "365d": "LAST_365_DAYS",
  all: "ALL",
  "this-month": "THIS_MONTH",
  "last-month": "LAST_MONTH",
  custom: "CUSTOM"
};
var DASHBOARD_ORDERS = {
  published: "PUBLISHED_DATE_DESC",
  pv: "PAGE_VIEW_COUNT_DESC",
  impressions: "IMPRESSION_COUNT_DESC",
  likes: "LIKE_COUNT_DESC",
  comments: "COMMENT_COUNT_DESC",
  sales: "SALES_DESC"
};
var DASHBOARD_METRICS = { impressions: "IMPRESSION", pv: "PAGE_VIEW", likes: "LIKE", comments: "COMMENT", sales: "SALES" };
function dashboardRange(period, opts = {}) {
  const now = opts.now ?? new Date;
  const day = (d) => {
    const jst = new Date(d.getTime() + 9 * 3600000);
    return jst.toISOString().slice(0, 10);
  };
  const minus = (days) => new Date(now.getTime() - days * 86400000);
  const today = day(now);
  switch (period) {
    case "7d":
      return { unit: "LAST_7_DAYS", date: day(minus(6)), endDate: null, from: day(minus(6)), to: today };
    case "28d":
      return { unit: "LAST_28_DAYS", date: day(minus(27)), endDate: null, from: day(minus(27)), to: today };
    case "365d":
      return { unit: "LAST_365_DAYS", date: day(minus(364)), endDate: null, from: day(minus(364)), to: today };
    case "all":
      return { unit: "ALL", date: today, endDate: null, from: null, to: today };
    case "this-month":
      return { unit: "THIS_MONTH", date: `${today.slice(0, 7)}-01`, endDate: null, from: `${today.slice(0, 7)}-01`, to: today };
    case "last-month": {
      const [y, m] = today.split("-").map(Number);
      const first = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
      return { unit: "LAST_MONTH", date: first, endDate: null, from: first, to: null };
    }
    case "custom": {
      if (!opts.from || !opts.to)
        throw new CliError("USAGE", "--period custom needs --from and --to (YYYY-MM-DD).");
      return { unit: "CUSTOM", date: opts.from, endDate: opts.to, from: opts.from, to: opts.to };
    }
  }
}
var rangeVars = (r) => ({ unit: r.unit, date: r.date, endDate: r.endDate });
var METRIC_FIELDS = "pageViewCount impressionCount likeCount commentCount salesAmount";
var metrics = (m) => ({
  pageViews: num(m?.pageViewCount),
  impressions: num(m?.impressionCount),
  likes: num(m?.likeCount),
  comments: num(m?.commentCount),
  sales: num(m?.salesAmount)
});
async function dashboardSummary(client, range) {
  const data = await graphql(client, `query Summary($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime) {
      dashboardSummary(unit: $unit, date: $date, endDate: $endDate) { lastUpdatedAt metrics { ${METRIC_FIELDS} } }
    }`, rangeVars(range));
  return { lastUpdatedAt: data?.dashboardSummary?.lastUpdatedAt ?? null, totals: metrics(data?.dashboardSummary?.metrics) };
}
async function dashboardNotes(client, range, opts) {
  const notes = [];
  let after = null;
  while (notes.length < opts.limit) {
    const data = await graphql(client, `query Notes($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime, $order: DashboardNoteListOrder, $first: Int!, $after: String) {
        dashboardNoteListConnection(unit: $unit, date: $date, endDate: $endDate, order: $order, first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { note { key title status publishedAt link { absoluteUrl } } metrics { ${METRIC_FIELDS} } } }
        }
      }`, { ...rangeVars(range), order: DASHBOARD_ORDERS[opts.order], first: Math.min(50, opts.limit - notes.length), after });
    const conn = data?.dashboardNoteListConnection;
    for (const edge of conn?.edges ?? []) {
      const n = edge?.node?.note ?? {};
      notes.push({
        key: n.key ?? null,
        title: n.title ?? null,
        status: n.status ?? null,
        publishedAt: n.publishedAt ?? null,
        url: n.link?.absoluteUrl ?? null,
        ...metrics(edge?.node?.metrics)
      });
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor)
      break;
    after = conn.pageInfo.endCursor;
  }
  return notes.slice(0, opts.limit);
}
async function dashboardReferrers(client, range) {
  const data = await graphql(client, `query Referrers($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime) {
      dashboardNoteReferrersChart(unit: $unit, date: $date, endDate: $endDate) { legend { name count } }
    }`, rangeVars(range));
  const legend = data?.dashboardNoteReferrersChart?.legend ?? [];
  return legend.map((l) => ({ name: l?.name ?? null, count: num(l?.count) }));
}
async function dashboardChart(client, range, metric) {
  const data = await graphql(client, `query Chart($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime, $metric: DashboardMetricKind!) {
      dashboardMetricChart(unit: $unit, date: $date, endDate: $endDate, metric: $metric) { granularity points { label value startDate endDate } }
    }`, { ...rangeVars(range), metric: DASHBOARD_METRICS[metric] });
  const chart = data?.dashboardMetricChart;
  return {
    granularity: chart?.granularity ?? null,
    points: (chart?.points ?? []).map((p) => ({ from: p?.startDate ?? null, to: p?.endDate ?? null, value: num(p?.value) }))
  };
}

// src/embeds.ts
import { basename as basename2 } from "path";
var SERVICES = Object.entries({
  instagram: String.raw`^https://www\.instagram\.com\/(p|reel)\/[0-9a-zA-Z\-_]+/?`,
  twitter: String.raw`^https://(?:(?:mobile\.)?twitter\.com|(?:mobile\.)?x\.com)\/[a-zA-Z0-9_]+\/status\/[0-9]+(\?.+)?`,
  twitterProfile: String.raw`^https://(?:(?:mobile\.)?twitter\.com|(?:mobile\.)?x\.com)\/(i\/events\/)?[a-zA-Z0-9_]+/?$`,
  youtube: String.raw`^https://(?:(?:www\.|m\.)?youtube\.com/(?:watch\?v=|live/|shorts/)|youtu\.be/)([a-zA-Z0-9\-_]+)(?:[?&].*)?$`,
  vimeo: String.raw`^https://(player\.)?vimeo\.com\/(video\/)?[0-9a-zA-Z]+(\?.+)?`,
  soundcloud: String.raw`^https://[m\.]?soundcloud\.com\/[0-9a-zA-Z\-_]+`,
  niconico: String.raw`^https://www\.nicovideo\.jp\/watch\/.+`,
  slideshare: String.raw`^https://www\.slideshare\.net\/[0-9a-zA-Z\-_]+\/.+`,
  speakerdeck: String.raw`^https://speakerdeck\.com\/[0-9a-zA-Z\-_]+\/.+`,
  googlemap: String.raw`^https://www\.google\.(com|co\.jp)\/maps[?/].+`,
  "googlemap-short-url": String.raw`^https://goo\.gl\/maps[?/].+`,
  googleform: String.raw`^https://docs\.google\.com\/forms\/d\/.+`,
  googlepresentation: String.raw`^https://docs\.google\.com\/presentation\/d\/.+`,
  flickr: String.raw`^https://(www\.flickr\.com\/photos|flic\.kr\/p)\/.+`,
  spotify: String.raw`^https://open\.spotify\.com\/(playlist|track|album|artist)\/.+`,
  spotifyLink: String.raw`^https://spotify\.link\/.+`,
  itunes: String.raw`^https://itunes\.apple\.com\/[a-z]{2}\/(album|playlist)\/.+`,
  "apple-music": String.raw`^https://music\.apple\.com\/[a-z]{2}\/(album|playlist)\/.+`,
  codepen: String.raw`^https://codepen\.io\/.*?\/.+`,
  gist: String.raw`^https://gist\.github\.com\/[0-9a-zA-Z\-_]+\/.+`,
  wantedly: String.raw`^https://www\.wantedly\.com\/projects\/([0-9]+)\/?`,
  tiktok: String.raw`^https://vt\.tiktok\.com\/[0-9a-zA-Z]+\/?`,
  "tiktok-web": String.raw`^https://www\.tiktok\.com\/@.+?\/video\/[0-9]+`,
  bandcamp: String.raw`^https://(.*\.)?bandcamp\.com\/(album|track)\/.+`,
  omny: String.raw`^https://(omny\.fm\/shows\/.+?\/playlists/.+|omny\.fm\/shows\/.+?\/[0-9a-zA-Z\-]+)`,
  voicy: String.raw`^https://voicy\.jp\/channel\/([0-9]+)\/([0-9]+)`,
  githubRepository: String.raw`^https://github\.com\/[0-9a-zA-Z\-_]+\/[0-9a-zA-Z\-_]+`,
  miro: String.raw`^https://miro\.com\/app\/board\/[0-9a-zA-Z\=\_]+/`,
  canva: String.raw`^https://www\.canva\.com\/design\/[0-9a-zA-Z]+\/view`,
  twitch: String.raw`^https://www\.twitch\.tv\/videos/[0-9]+`,
  googleDriveFolder: String.raw`^https://drive\.google\.com\/drive\/folders\/[0-9a-zA-Z\-_]+`,
  googleDriveFile: String.raw`^https://drive\.google\.com\/file\/d\/[0-9a-zA-Z\-_]+\/view`,
  bluesky: String.raw`^https:\/\/bsky\.app\/profile\/([^\/]+)(?:\/post\/([^\/]+))?$`,
  threads: String.raw`^https:\/\/www\.threads\.(net|com)\/([^\/]+)(?:\/post\/([^\/]+))?$`,
  "apple-podcast": String.raw`^https://podcasts\.apple\.com\/[a-z]{2}\/podcast\/(.+\/)?id[0-9]+`
}).map(([name, pattern]) => [name, new RegExp(pattern)]);
var NOTE_ARTICLE = /^https:\/\/note\.com\/[A-Za-z0-9_-]+\/n\/(n[0-9a-f]{8,})\/?(?:[?#].*)?$/;
function embedService(url) {
  if (NOTE_ARTICLE.test(url))
    return "note";
  return SERVICES.find(([, re2]) => re2.test(url))?.[0] ?? null;
}
async function createEmbed(client, noteKey, url) {
  const article = url.match(NOTE_ARTICLE);
  if (article) {
    const form = new FormData;
    form.append("url", url);
    form.append("height", "211");
    form.append("embeddable_type", "Note");
    form.append("embeddable_key", noteKey);
    const res2 = await client.request("/v1/embed", { method: "POST", auth: "required", editor: true, form });
    const key2 = res2?.data?.embedded_content?.key;
    if (typeof key2 !== "string")
      throw new CliError("API_ERROR", `note did not return an embed for ${url}.`, { detail: res2 });
    return { service: "note", key: key2, url, identifier: article[1], html: null };
  }
  let service = embedService(url);
  if (!service) {
    const check = await client.request("/v2/embed_by_external_api/check_type", { auth: "required", editor: true, query: { url } });
    const type = check?.data?.type;
    service = type === "Oembed" ? "oembed" : type === "JobPosting" ? "hr" : typeof type === "string" && type ? type : "external-article";
  }
  const res = await client.request("/v2/embed_by_external_api", {
    auth: "required",
    editor: true,
    query: { url, service, embeddable_key: noteKey, embeddable_type: "Note" }
  });
  const key = res?.data?.key;
  if (typeof key !== "string")
    throw new CliError("API_ERROR", `note did not return an embed for ${url}.`, { detail: res });
  return { service, key, url, identifier: null, html: null };
}
async function uploadAttachment(client, noteKey, file) {
  const name = basename2(file.path);
  const form = new FormData;
  form.append("file", new Blob([file.bytes], { type: file.mimeType }), name);
  form.append("file_name", name);
  form.append("note_key", noteKey);
  const res = await client.request("/v2/attachments/upload", { method: "POST", auth: "required", editor: true, form });
  const d = res?.data;
  if (d?.error)
    throw new CliError("API_ERROR", `Attachment ${name} was rejected: ${d.error?.message ?? JSON.stringify(d.error)}`, { detail: res });
  if (typeof d?.embedded_content_key !== "string" || typeof d?.html_for_embed !== "string") {
    throw new CliError("API_ERROR", `note did not accept the attachment ${name}.`, { detail: res });
  }
  return { service: "attachment", key: d.embedded_content_key, url: null, identifier: d.attachment_key ?? null, html: d.html_for_embed };
}
var MIME = {
  pdf: "application/pdf",
  zip: "application/zip",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  epub: "application/epub+zip",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
function attachmentMime(path) {
  return MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

// src/browser.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile as readFile3, rm as rm2 } from "fs/promises";
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
    return new Promise((resolve2, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve2(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }));
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
      const [port, path] = (await readFile3(file, "utf8")).trim().split(`
`);
      if (port && path)
        return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await sleep(200);
  }
  throw new CliError("BROWSER_LAUNCH_FAILED", "Timed out waiting for the browser's DevTools port.");
}
async function launchBrowser(opts) {
  const executable = findBrowser(opts.browser);
  const profileDir = await mkdtemp(join2(tmpdir(), opts.prefix));
  const proc = spawn(executable, [`--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", opts.url], { stdio: "ignore" });
  const cleanup = async () => {
    proc.kill();
    await sleep(300);
    await rm2(profileDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const cdp = await Cdp.connect(await waitForDevToolsPort(profileDir, proc));
    return {
      cdp,
      proc,
      async close() {
        cdp.close();
        await cleanup();
      }
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// src/login.ts
async function browserLogin(opts) {
  const { cdp, proc, close } = await launchBrowser({ browser: opts.browser, url: "https://note.com/login", prefix: "note-cli-login-" });
  try {
    console.error("Log in to note.com in the opened browser window. Waiting...");
    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new CliError("LOGIN_ABORTED", "The browser was closed before login completed.");
      const { targetInfos } = await cdp.send("Target.getTargets");
      const onLoginPage = targetInfos.some((t) => t.type === "page" && /note\.com\/login/.test(t.url));
      if (!onLoginPage) {
        const { cookies } = await cdp.send("Storage.getCookies");
        const map = Object.fromEntries(cookies.filter((c2) => /(^|\.)note\.com$/.test(c2.domain.replace(/^\./, ""))).map((c2) => [c2.name, c2.value]));
        if (map._note_session_v5 && await opts.isLoggedIn(map))
          return map;
      }
      await sleep(1500);
    }
    throw new CliError("LOGIN_TIMEOUT", `Login was not completed within ${opts.timeoutSec}s.`);
  } finally {
    await close();
  }
}

// src/publish.ts
var VOID_TAGS = new Set(["br", "img", "hr", "input", "source", "wbr"]);
function topLevelBlocks(html) {
  const blocks = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let depth = 0;
  let start = 0;
  let m;
  while (m = tag.exec(html)) {
    const [, closing, nameRaw, selfClosing] = m;
    const name = nameRaw.toLowerCase();
    if (closing)
      depth--;
    else if (!selfClosing && !VOID_TAGS.has(name))
      depth++;
    if (depth === 0) {
      const block = html.slice(start, tag.lastIndex).trim();
      if (block)
        blocks.push(block);
      start = tag.lastIndex;
    }
  }
  const tail = html.slice(start).trim();
  if (tail)
    blocks.push(tail);
  return blocks;
}
var isPaywall = (block) => /^<paywall-line\b/i.test(block);
function imageKey(src) {
  try {
    const last = new URL(src).pathname.split("/").pop() ?? "";
    return last.match(/[a-f0-9]{32}/)?.[0] ?? last.match(/[^.]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}
function buildPublishPayload(note, s) {
  const blocks = topLevelBlocks(note.body);
  const paywallAt = blocks.findIndex(isPaywall);
  const content = blocks.filter((b) => !isPaywall(b));
  let separator = null;
  if (paywallAt > 0) {
    separator = blocks[paywallAt - 1].match(/\sname="([^"]+)"/)?.[1] ?? null;
    if (!separator)
      throw new CliError("INVALID_INPUT", "The block before the paywall line has no name attribute; re-save the draft with note-cli.");
  }
  if (s.price > 0 && !separator) {
    throw new CliError("INVALID_INPUT", "A paid article needs a paywall: put `<!-- paywall -->` in the Markdown where the paid part starts (or place the line in the editor).");
  }
  const freeCount = separator && s.price > 0 ? paywallAt : content.length;
  const imageKeys = content.flatMap((b) => [...b.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => imageKey(m[1]))).filter((k) => !!k);
  const html = content.join("");
  return {
    author_ids: [],
    body_length: visibleTextLength(html),
    disable_comment: s.disableComments,
    exclude_from_creator_top: Boolean(s.hideFromProfile),
    exclude_ai_learning_reward: false,
    free_body: content.slice(0, freeCount).join(""),
    pay_body: content.slice(freeCount).join(""),
    hashtags: s.hashtags.map((h) => `#${h.replace(/^[#\uFF03]/, "")}`),
    image_keys: imageKeys,
    index: s.toc,
    is_refund: s.price > 0 && s.refund,
    limited: false,
    magazine_ids: [],
    magazine_keys: s.magazineKeys,
    name: note.name,
    price: s.price,
    send_notifications_flag: s.notify,
    separator: s.price > 0 ? separator : null,
    ...note.slug || note.key ? { slug: note.slug || `slug-${note.key}` } : {},
    ...s.circlePermissions ? { circle_permissions: s.circlePermissions } : {},
    status: s.publishAt ? "reserved" : "published",
    ...s.publishAt ? { publish_at: s.publishAt } : {},
    discount_campaigns: []
  };
}
var RECAPTCHA_SITE_KEY = "6LefXTAsAAAAADYVISEItAl0IX1rgSGQ-asNy56w";
var PAGE_SCRIPT = `async ({ noteId, payload, xsrf, siteKey }) => {
  const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
  if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
  const api = async (path, init = {}) => {
    const r = await fetch("https://note.com/api" + path, { credentials: "include", ...init, headers });
    const text = await r.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body };
  };
  const ch = await api("/v3/challenges?via=note_post");
  const challenges = (ch.body && ch.body.data && ch.body.data.challenges) || [];
  let verification = null;
  if (challenges.includes("reCAPTCHAv3")) {
    if (!window.grecaptcha || !window.grecaptcha.enterprise) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://www.google.com/recaptcha/enterprise.js?render=" + encodeURIComponent(siteKey);
        s.onload = resolve;
        s.onerror = () => reject(new Error("could not load reCAPTCHA"));
        document.head.appendChild(s);
      });
    }
    const token = await new Promise((resolve, reject) =>
      window.grecaptcha.enterprise.ready(() =>
        window.grecaptcha.enterprise.execute(siteKey, { action: "note_post" }).then(resolve, reject)));
    const v = await api("/v3/challenges/verifications", {
      method: "POST",
      body: JSON.stringify({ g_recaptcha_token_v3: token, g_recaptcha_action_v3: "note_post", via: "note_post" }),
    });
    verification = v.status;
  }
  const put = await api("/v1/text_notes/" + noteId, { method: "PUT", body: JSON.stringify(payload) });
  return { challenges, verification, status: put.status, body: put.body };
}`;
async function publishInBrowser(opts) {
  const { cdp, close } = await launchBrowser({ browser: opts.browser, url: "about:blank", prefix: "note-cli-publish-" });
  try {
    await cdp.send("Storage.setCookies", {
      cookies: Object.entries(opts.cookies).map(([name, value]) => ({
        name,
        value,
        domain: ".note.com",
        path: "/",
        secure: true,
        httpOnly: name !== "XSRF-TOKEN",
        sameSite: "Lax"
      }))
    });
    const { targetInfos } = await cdp.send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page");
    if (!page)
      throw new CliError("BROWSER_LAUNCH_FAILED", "The browser opened no page.");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await cdp.send("Page.navigate", { url: `https://editor.note.com/notes/${opts.noteKey}/publish/` }, sessionId);
    const evaluate = async (expression, awaitPromise = false) => {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId);
      if (r.exceptionDetails) {
        throw new CliError("PUBLISH_FAILED", `Browser script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      }
      return r.result?.value;
    };
    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (await evaluate("location.host + ' ' + document.readyState").catch(() => "") !== "editor.note.com complete") {
      if (Date.now() > deadline)
        throw new CliError("PUBLISH_FAILED", "Timed out loading the note editor in the browser.");
      await sleep(500);
    }
    if (await evaluate("location.pathname.startsWith('/login') || location.host === 'note.com'")) {
      throw new CliError("AUTH_ERROR", "The browser was not logged in; run `note-cli auth login` again.");
    }
    const args = JSON.stringify({
      noteId: opts.noteId,
      payload: opts.payload,
      xsrf: opts.cookies["XSRF-TOKEN"] ? safeDecode2(opts.cookies["XSRF-TOKEN"]) : null,
      siteKey: RECAPTCHA_SITE_KEY
    });
    return await evaluate(`(${PAGE_SCRIPT})(${args})`, true);
  } finally {
    await close();
  }
}
function safeDecode2(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// src/validate.ts
var NOTE_KEY = /^n[0-9a-z]{6,32}$/;
var URLNAME = /^[A-Za-z0-9_-]{1,64}$/;
function noteKey(input) {
  const s = input.trim();
  const fromUrl = s.match(/(?:^|\/)(n[0-9a-z]{6,32})(?:[/?#]|$)/)?.[1];
  const key = fromUrl ?? s;
  if (!NOTE_KEY.test(key))
    throw new CliError("USAGE", `Not a note key or note URL: "${input}". Expected something like n1a2b3c4d5e6.`);
  return key;
}
function noteIdOrKey(input) {
  const s = input.trim();
  if (/^\d{1,12}$/.test(s))
    return { id: Number(s) };
  return { key: noteKey(s) };
}
function urlname(input) {
  const s = input.trim().replace(/^@/, "");
  const fromUrl = s.match(/^https?:\/\/note\.com\/([^/?#]+)/)?.[1];
  const name = fromUrl ?? s;
  if (!URLNAME.test(name))
    throw new CliError("USAGE", `Not a note urlname: "${input}". Use letters, digits, _ or -.`);
  return name;
}
function hashtag(input) {
  const name = input.trim().replace(/^#/, "");
  if (!name || name.length > 100 || /[\s/\\?#%.]/.test(name)) {
    throw new CliError("USAGE", `Not a valid hashtag: "${input}" (no spaces, dots or / ? # %).`);
  }
  return name;
}
var MAGAZINE_KEY = /^m[0-9a-z]{6,32}$/;
function magazineKey(input) {
  const s = input.trim();
  const fromUrl = s.match(/\/m\/(m[0-9a-z]{6,32})(?:[/?#]|$)/)?.[1];
  const key = fromUrl ?? s;
  if (!MAGAZINE_KEY.test(key)) {
    throw new CliError("USAGE", `Not a magazine key or URL: "${input}". Expected something like m97e554a23b24.`);
  }
  return key;
}
function categorySlug(input) {
  const s = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(s))
    throw new CliError("USAGE", `Not a category slug: "${input}". Run \`note-cli categories\`.`);
  return s;
}
function token(input, what) {
  const s = input.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s))
    throw new CliError("USAGE", `Not a valid ${what}: "${input}".`);
  return s;
}

// src/cli.ts
var SORTS = ["popular", "hot", "new"];
var DEFAULT_MAX_CHARS = "20000";
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
    usage: "auth import [--cookie '<Cookie header or _note_session_v5 value>']   (or pipe it via stdin)",
    summary: "Save a session from a Cookie header (or just the _note_session_v5 value) copied from browser DevTools",
    options: { cookie: { type: "string" } },
    async run({ values }) {
      const raw = typeof values.cookie === "string" ? values.cookie : await readStdin();
      return finishLogin(parseImportedCookies(raw));
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
    usage: "draft create <file.md|-> [--title <title>] [--eyecatch <image>] [--no-embed] [--dry-run]",
    summary: "Create a new draft from Markdown; local images are uploaded, a URL alone on its line becomes an embed, a link alone to a local file an attachment",
    options: { title: { type: "string" }, eyecatch: { type: "string" }, "no-embed": { type: "boolean" }, "dry-run": { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const input = await readArticleInput(positionals[0], values, client);
      if (values["dry-run"])
        return dryRunResult(input);
      const imageUrls = await uploadImages(client, input);
      const draft = await createDraft(client, input.title);
      const article = await uploadAndConvert(client, input, draft.key, imageUrls);
      await saveDraft(client, draft.id, article);
      const eyecatch = await applyEyecatch(client, draft.id, input.eyecatch, article);
      return {
        created: true,
        ...draft,
        title: article.title,
        bodyLength: article.bodyLength,
        ...imagesField(article.images, eyecatch, article.embeds),
        warnings: [...article.warnings, ...eyecatch.warnings]
      };
    }
  },
  "draft update": {
    usage: "draft update <id|key|url> <file.md|-> [--title <title>] [--eyecatch <image>] [--no-embed] [--dry-run]",
    summary: "Overwrite an existing draft's title and body with Markdown (images, embeds and attachments as in draft create)",
    options: { title: { type: "string" }, eyecatch: { type: "string" }, "no-embed": { type: "boolean" }, "dry-run": { type: "boolean" } },
    args: 2,
    async run({ values, positionals, client }) {
      const ref = noteIdOrKey(positionals[0]);
      const input = await readArticleInput(positionals[1], values, client);
      if (values["dry-run"])
        return dryRunResult(input);
      const { id, key } = await resolveNoteId(client, ref);
      const article = await uploadAndConvert(client, input, key);
      await saveDraft(client, id, article);
      const eyecatch = await applyEyecatch(client, id, input.eyecatch, article);
      return {
        updated: true,
        id,
        key,
        editUrl: key ? editUrl(key) : null,
        title: article.title,
        bodyLength: article.bodyLength,
        ...imagesField(article.images, eyecatch, article.embeds),
        warnings: [...article.warnings, ...eyecatch.warnings]
      };
    }
  },
  "draft get": {
    usage: "draft get <key|url> [--html] [--max-chars <n>]",
    summary: "Read a draft (or your own article) as the editor sees it",
    options: { html: { type: "boolean" }, "max-chars": { type: "string", default: DEFAULT_MAX_CHARS } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      const maxChars = int(values["max-chars"], "max-chars");
      const data = await getDraft(client, key);
      if (!data || typeof data !== "object")
        throw new CliError("NOT_FOUND", `No draft data for ${key}.`);
      const draft = data.note_draft ?? data;
      const html = typeof draft.body === "string" ? draft.body : typeof data.body === "string" ? data.body : "";
      return {
        id: data.id,
        key: data.key,
        status: data.status,
        title: draft.name ?? data.name,
        editUrl: data.key ? editUrl(data.key) : null,
        ...bodyField(html, Boolean(values.html), maxChars)
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
      return { page: int(values.page, "page"), isLastPage: res.isLastPage, count: items.length, notes: items, ...skippedField(res.skipped) };
    }
  },
  "draft delete": {
    usage: "draft delete <id|key|url> --yes",
    summary: "Delete a draft (drafts only; use `delete` for a published article)",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const ref = noteIdOrKey(positionals[0]);
      if (!values.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the draft.");
      const { id, key } = await resolveNoteId(client, ref);
      await deleteDraft(client, id);
      return { deleted: true, id, key };
    }
  },
  "photo search": {
    usage: "photo search [keyword...] [--public-domain] [--limit <n>] [--page <n>]",
    summary: "Search \u307F\u3093\u306A\u306E\u30D5\u30A9\u30C8\u30AE\u30E3\u30E9\u30EA\u30FC (free photos for covers, as in the editor's \u8A18\u4E8B\u306B\u3042\u3046\u753B\u50CF\u3092\u9078\u3076); pass an item's `eyecatch` to --eyecatch",
    options: {
      "public-domain": { type: "boolean" },
      limit: { type: "string", default: "20" },
      page: { type: "string", default: "1" }
    },
    async run({ values, positionals, client }) {
      const query = positionals.join(" ").trim();
      const size = int(values.limit, "limit");
      const page = int(values.page, "page");
      if (size < 1 || size > 100)
        throw new CliError("USAGE", "--limit must be between 1 and 100.");
      if (page < 1)
        throw new CliError("USAGE", "--page must be 1 or more.");
      const publicDomainOnly = values["public-domain"] === true;
      const res = await searchStockPhotos(client, { query, page, size, publicDomainOnly });
      return {
        query,
        ...publicDomainOnly ? { publicDomainOnly } : {},
        page,
        count: res.items.length,
        isLastPage: res.isLastPage,
        photos: res.items,
        ...skippedField(res.skipped)
      };
    }
  },
  search: {
    usage: "search <query> [--type note|user|magazine|hashtag] [--sort popular|hot|new] [--limit <n>] [--start <n>]",
    summary: "Search articles (default), creators, magazines or hashtags by keyword (--sort applies to articles only)",
    options: {
      type: { type: "string", default: "note" },
      sort: { type: "string", default: "popular" },
      limit: { type: "string", default: "20" },
      start: { type: "string", default: "0" }
    },
    args: 1,
    async run({ values, positionals, client }) {
      const q2 = positionals.join(" ");
      const type = oneOf(values.type, ["note", "user", "magazine", "hashtag"], "type");
      if (type !== "note") {
        const res2 = await searchOther(client, type, q2, {
          limit: int(values.limit, "limit"),
          start: int(values.start, "start")
        });
        const field = { user: "users", magazine: "magazines", hashtag: "hashtags" }[type];
        return { query: q2, type, total: res2.total, count: res2.items.length, exhausted: res2.exhausted, [field]: res2.items, ...skippedField(res2.skipped) };
      }
      const res = await searchNotes(client, q2, {
        sort: oneOf(values.sort, SORTS, "sort"),
        limit: int(values.limit, "limit"),
        start: int(values.start, "start")
      });
      return { query: q2, total: res.total, count: res.items.length, exhausted: res.exhausted, notes: res.items, ...skippedField(res.skipped) };
    }
  },
  hashtag: {
    usage: "hashtag <tag> [--order popular|hot|new] [--limit <n>] [--paid-only]",
    summary: "List articles for a hashtag, with its total article count and related hashtags",
    options: {
      order: { type: "string", default: "popular" },
      limit: { type: "string", default: "50" },
      "paid-only": { type: "boolean" }
    },
    args: 1,
    async run({ values, positionals, client }) {
      const tag = hashtag(positionals[0]);
      const order = oneOf(values.order, SORTS, "order");
      const info = await hashtagInfo(client, tag).catch((e) => {
        if (e instanceof CliError && e.code !== "NOT_LOGGED_IN")
          return null;
        throw e;
      });
      const res = await hashtagNotes(client, tag, {
        order,
        limit: int(values.limit, "limit"),
        paidOnly: Boolean(values["paid-only"])
      });
      return {
        hashtag: tag,
        articleCount: info?.count ?? null,
        relatedHashtags: info?.related ?? [],
        total: res.total,
        count: res.items.length,
        exhausted: res.exhausted,
        notes: res.items,
        ...skippedField(res.skipped)
      };
    }
  },
  user: {
    usage: "user <urlname> [--limit <n>]",
    summary: "Show a creator's profile and recent articles",
    options: { limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const urlname2 = urlname(positionals[0]);
      const creator = await getCreator(client, urlname2);
      const res = await creatorNotes(client, urlname2, { limit: int(values.limit, "limit") });
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
        exhausted: res.exhausted,
        notes: res.items,
        ...skippedField(res.skipped)
      };
    }
  },
  note: {
    usage: "note <key|url> [--html] [--max-chars <n>]",
    summary: "Read a published article (summary + body text; paid parts are hidden)",
    options: { html: { type: "boolean" }, "max-chars": { type: "string", default: DEFAULT_MAX_CHARS } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      const maxChars = int(values["max-chars"], "max-chars");
      const data = await getNote(client, key);
      const summary = tryNormalizeNote(data);
      if (typeof summary === "string") {
        throw new CliError("API_ERROR", `Unexpected response for ${key}: ${summary}.`);
      }
      const body = typeof data.body === "string" ? data.body : "";
      return {
        ...summary,
        description: data.description ?? null,
        canRead: data.can_read ?? data.canRead ?? null,
        ...bodyField(body, Boolean(values.html), maxChars)
      };
    }
  },
  likes: {
    usage: "likes <key|url> [--limit <n>]",
    summary: "List who liked an article (newest first)",
    options: { limit: { type: "string", default: "50" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      const res = await noteLikes(client, key, { limit: int(values.limit, "limit") });
      return { key, total: res.total, count: res.items.length, exhausted: res.exhausted, likes: res.items, ...skippedField(res.skipped) };
    }
  },
  comments: {
    usage: "comments <key|url> [--limit <n>]",
    summary: "Read an article's comments (top-level; replies are counted in replyCount)",
    options: { limit: { type: "string", default: "50" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      const res = await noteComments(client, key, { limit: int(values.limit, "limit") });
      return { key, total: res.total, count: res.items.length, exhausted: res.exhausted, comments: res.items, ...skippedField(res.skipped) };
    }
  },
  magazine: {
    usage: "magazine <key|url> [--limit <n>]",
    summary: "Show a magazine and its articles (in the magazine's order)",
    options: { limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = magazineKey(positionals[0]);
      const magazine = await getMagazine(client, key);
      const res = await magazineNotes(client, key, { limit: int(values.limit, "limit") });
      return { magazine, count: res.items.length, exhausted: res.exhausted, notes: res.items, ...skippedField(res.skipped) };
    }
  },
  categories: {
    usage: "categories",
    summary: "List note's article categories (use the slug with `category`)",
    async run({ client }) {
      return { categories: await categories(client) };
    }
  },
  category: {
    usage: "category <slug> [--sort new|trend] [--limit <n>]",
    summary: "List articles in a category; `featured` is note's editorial pick (sort does not apply)",
    options: { sort: { type: "string", default: "new" }, limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const slug = categorySlug(positionals[0]);
      const sort = oneOf(values.sort, ["new", "trend"], "sort");
      const res = await categoryNotes(client, slug, { sort, limit: int(values.limit, "limit") });
      return { category: slug, sort: slug === "featured" ? null : sort, count: res.items.length, exhausted: res.exhausted, notes: res.items, ...skippedField(res.skipped) };
    }
  },
  contests: {
    usage: "contests [--state opened|closed|finished|all] [--type contest|theme|all] [--limit <n>]",
    summary: "List note's contests and themed hashtags (closing soonest first)",
    options: {
      state: { type: "string", default: "opened" },
      type: { type: "string", default: "all" },
      limit: { type: "string", default: "50" }
    },
    async run({ values, client }) {
      const state = oneOf(values.state, ["opened", "closed", "finished", "all"], "state");
      const type = oneOf(values.type, ["contest", "theme", "all"], "type");
      const limit = int(values.limit, "limit");
      const res = await contests(client);
      const items = res.items.filter((c2) => state === "all" || c2.state === state).filter((c2) => type === "all" || type === "theme" === (c2.type === "theme")).sort((a3, b) => (a3.closeAt ?? "9999").localeCompare(b.closeAt ?? "9999"));
      return { state, type, total: items.length, count: Math.min(items.length, limit), contests: items.slice(0, limit), ...skippedField(res.skipped) };
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
      return { source: { type: "search", query: q2, sort: values.sort, total: res.total }, ...skippedField(res.skipped), ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
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
      const tag = hashtag(positionals[0]);
      const res = await hashtagNotes(client, tag, {
        order: oneOf(values.order, SORTS, "order"),
        limit: int(values.limit, "limit")
      });
      return { source: { type: "hashtag", hashtag: tag, order: values.order, total: res.total }, ...skippedField(res.skipped), ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    }
  },
  "analyze user": {
    usage: "analyze user <urlname> [--limit <n>] [--top <n>]",
    summary: "Summarize a creator's articles (yours or a competitor's)",
    options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" } },
    args: 1,
    async run({ values, positionals, client }) {
      const urlname2 = urlname(positionals[0]);
      const res = await creatorNotes(client, urlname2, { limit: int(values.limit, "limit") });
      return { source: { type: "user", urlname: urlname2, total: res.total }, ...skippedField(res.skipped), ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    }
  },
  "stats pv": {
    usage: "stats pv [--filter all|daily|weekly|monthly|yearly] [--sort pv|like|comment] [--page <n>]",
    summary: "Your own page views / likes / comments per article (requires login)",
    options: {
      filter: { type: "string", default: "all" },
      sort: { type: "string", default: "pv" },
      page: { type: "string", default: "1" }
    },
    async run({ values, client }) {
      return statsPv(client, {
        filter: oneOf(values.filter, ["all", "daily", "weekly", "monthly", "yearly"], "filter"),
        sort: oneOf(values.sort, ["pv", "like", "comment"], "sort"),
        page: int(values.page, "page")
      });
    }
  },
  "stats dashboard": {
    usage: "stats dashboard [--period 7d|28d|365d|all|this-month|last-month|custom] [--from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--order published|pv|impressions|likes|comments|sales] [--limit <n>]",
    summary: "Your dashboard for a period (requires login): totals incl. impressions and sales, where readers came from, and per-article numbers",
    options: {
      period: { type: "string", default: "28d" },
      from: { type: "string" },
      to: { type: "string" },
      order: { type: "string", default: "pv" },
      limit: { type: "string", default: "20" }
    },
    async run({ values, client }) {
      const range = dashboardRangeFrom(values);
      const order = oneOf(values.order, Object.keys(DASHBOARD_ORDERS), "order");
      const limit = int(values.limit, "limit");
      const summary = await dashboardSummary(client, range);
      const referrers = await dashboardReferrers(client, range);
      const notes = limit > 0 ? await dashboardNotes(client, range, { order, limit }) : [];
      return {
        period: values.period,
        from: range.from,
        to: range.to,
        lastUpdatedAt: summary.lastUpdatedAt,
        totals: summary.totals,
        referrers,
        ...limit > 0 ? { order, notes } : {}
      };
    }
  },
  "stats chart": {
    usage: "stats chart [--metric pv|impressions|likes|comments|sales] [--period 7d|28d|365d|all|this-month|last-month|custom] [--from <YYYY-MM-DD> --to <YYYY-MM-DD>]",
    summary: "One of your metrics over time (by day, week or month depending on the period; requires login)",
    options: {
      metric: { type: "string", default: "pv" },
      period: { type: "string", default: "28d" },
      from: { type: "string" },
      to: { type: "string" }
    },
    async run({ values, client }) {
      const metric = oneOf(values.metric, Object.keys(DASHBOARD_METRICS), "metric");
      const range = dashboardRangeFrom(values);
      return { metric, period: values.period, from: range.from, to: range.to, ...await dashboardChart(client, range, metric) };
    }
  },
  publish: {
    usage: "publish <key|url> [file.md|-] --yes [--hashtag <tag>]... [--price <yen>] [--magazine <key>]... [--membership all|none|<planKey>]... [--schedule <time>] [--toc] [--disable-comments] [--refund] [--no-notify] [--hide-from-profile] [--title <t>] [--eyecatch <image>] [--no-embed] [--dry-run] [--browser <path>] [--timeout <sec>]",
    summary: "Publish a draft (or re-publish an article), optionally saving a Markdown file to it first. A browser window opens briefly to pass note's reCAPTCHA",
    options: {
      yes: { type: "boolean" },
      hashtag: { type: "string", multiple: true },
      price: { type: "string", default: "0" },
      magazine: { type: "string", multiple: true },
      membership: { type: "string", multiple: true },
      "hide-from-profile": { type: "boolean" },
      schedule: { type: "string" },
      toc: { type: "boolean" },
      "disable-comments": { type: "boolean" },
      refund: { type: "boolean" },
      "no-notify": { type: "boolean" },
      "no-embed": { type: "boolean" },
      title: { type: "string" },
      eyecatch: { type: "string" },
      "dry-run": { type: "boolean" },
      browser: { type: "string" },
      timeout: { type: "string", default: "120" }
    },
    args: 1,
    async run({ values, positionals, client, deps }) {
      const key = noteKey(positionals[0]);
      const settings = publishSettings(values);
      const membership = list(values.membership);
      if (membership.length)
        settings.circlePermissions = circlePermissions(membership, await membershipAccess(client));
      const timeoutSec = int(values.timeout, "timeout");
      const input = positionals[1] ? await readArticleInput(positionals[1], values, client) : null;
      if (values["dry-run"]) {
        const note2 = input ? { name: input.title, body: dryRunResult(input).html, slug: null, key } : await savedNote(client, key);
        return { dryRun: true, key, ...publishPreview(buildPublishPayload(note2, settings)) };
      }
      if (!values.yes) {
        throw new CliError("CONFIRMATION_REQUIRED", "Publishing makes the article public. Pass --yes to publish (try --dry-run first).");
      }
      const session = await client.getSession();
      if (!session?.cookies._note_session_v5) {
        throw new CliError("NOT_LOGGED_IN", "Not logged in. Run `note-cli auth login` (or `note-cli auth import`).");
      }
      const current = await getDraft(client, key);
      if (!current?.id)
        throw new CliError("NOT_FOUND", `Could not find your article ${key}.`);
      const id = Number(current.id);
      let note = noteFromDraft(current);
      const extra = {};
      const warnings = [];
      if (input) {
        const article = await uploadAndConvert(client, input, key);
        await saveDraft(client, id, article);
        const eyecatch = await applyEyecatch(client, id, input.eyecatch, article);
        note = { ...note, name: article.title, body: article.html };
        Object.assign(extra, imagesField(article.images, eyecatch, article.embeds));
        warnings.push(...article.warnings, ...eyecatch.warnings);
      }
      const payload = buildPublishPayload(note, settings);
      const res = await (deps.publish ?? publishInBrowser)({
        cookies: session.cookies,
        noteId: id,
        noteKey: key,
        payload,
        browser: typeof values.browser === "string" ? values.browser : undefined,
        timeoutSec
      });
      if (res.status < 200 || res.status >= 300)
        throw publishError(res, settings);
      const urlname2 = session.urlname ?? current.user?.urlname;
      return {
        [settings.publishAt ? "scheduled" : "published"]: true,
        id,
        key,
        title: note.name,
        url: res.body?.data?.note_url ?? (urlname2 ? `https://note.com/${urlname2}/n/${key}` : null),
        ...settings.publishAt ? { publishAt: settings.publishAt } : {},
        price: settings.price,
        hashtags: settings.hashtags,
        ...extra,
        warnings
      };
    }
  },
  unpublish: {
    usage: "unpublish <key|url> --yes",
    summary: "Turn a published (or scheduled) article back into a draft; paid or sold articles cannot be",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      if (!values.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to take the article down (it becomes a draft).");
      await changeToDraft(client, key);
      return { unpublished: true, key, status: "draft" };
    }
  },
  delete: {
    usage: "delete <key|url> --yes",
    summary: "Delete one of your articles for good; a published one is turned back into a draft first",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      if (!values.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the article. This cannot be undone.");
      const data = await getDraft(client, key);
      if (!data?.id)
        throw new CliError("NOT_FOUND", `Could not find your article ${key}.`);
      const id = Number(data.id);
      const wasStatus = typeof data.status === "string" ? data.status : null;
      if (wasStatus && wasStatus !== "draft")
        await changeToDraft(client, key);
      await deleteDraft(client, id);
      return { deleted: true, id, key, wasStatus };
    }
  },
  reserved: {
    usage: "reserved",
    summary: "List your scheduled articles",
    async run({ client }) {
      const res = await reservedNotes(client);
      return { count: res.items.length, notes: res.items, ...skippedField(res.skipped) };
    }
  },
  like: {
    usage: "like <key|url>",
    summary: "Like (\u30B9\u30AD) an article",
    args: 1,
    async run({ positionals, client }) {
      const key = noteKey(positionals[0]);
      await likeNote(client, key, true);
      return { liked: true, key };
    }
  },
  unlike: {
    usage: "unlike <key|url>",
    summary: "Remove your like from an article",
    args: 1,
    async run({ positionals, client }) {
      const key = noteKey(positionals[0]);
      await likeNote(client, key, false);
      return { liked: false, key };
    }
  },
  comment: {
    usage: "comment <key|url> <text|-> [--reply-to <commentKey>]",
    summary: "Post a comment (or a reply) on an article; `-` reads the text from stdin",
    options: { "reply-to": { type: "string" } },
    args: 2,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      const text = (positionals[1] === "-" && positionals.length === 2 ? await readStdin() : positionals.slice(1).join(" ")).trim();
      if (!text)
        throw new CliError("INVALID_INPUT", "The comment is empty.");
      const replyTo = typeof values["reply-to"] === "string" ? token(values["reply-to"], "comment key") : undefined;
      try {
        return { posted: true, key, comment: await postComment(client, key, text, { replyTo }) };
      } catch (e) {
        if (e instanceof CliError && e.detail?.error?.type === "comment_acknowledgement") {
          throw new CliError("COMMENT_GUIDELINES", "note asks you to accept its comment guidelines once: open any article in a browser, start a comment, and accept the guidelines. Then retry.", { status: e.status, detail: e.detail });
        }
        throw e;
      }
    }
  },
  "comment delete": {
    usage: "comment delete <key|url> <commentKey> --yes",
    summary: "Delete a comment (your own, or any comment on your article)",
    options: { yes: { type: "boolean" } },
    args: 2,
    async run({ values, positionals, client }) {
      const key = noteKey(positionals[0]);
      const commentKey = token(positionals[1], "comment key");
      if (!values.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the comment.");
      await deleteComment(client, key, commentKey);
      return { deleted: true, key, commentKey };
    }
  },
  follow: {
    usage: "follow <urlname>",
    summary: "Follow a creator",
    args: 1,
    async run({ positionals, client }) {
      return follow(client, urlname(positionals[0]), true);
    }
  },
  unfollow: {
    usage: "unfollow <urlname>",
    summary: "Unfollow a creator",
    args: 1,
    async run({ positionals, client }) {
      return follow(client, urlname(positionals[0]), false);
    }
  },
  magazines: {
    usage: "magazines [--note <key|url>]",
    summary: "List your own magazines (with --note: whether that article is already in each)",
    options: { note: { type: "string" } },
    async run({ values, client }) {
      const note = typeof values.note === "string" ? noteKey(values.note) : undefined;
      const items = await myMagazines(client, note);
      return { count: items.length, magazines: items };
    }
  },
  "magazine add": {
    usage: "magazine add <magazineKey|url> <noteKey|url>",
    summary: "Add an article (yours or anyone's published one) to your magazine",
    args: 2,
    async run({ positionals, client }) {
      const magazine = magazineKey(positionals[0]);
      const key = noteKey(positionals[1]);
      await addToMagazine(client, magazine, key, true);
      return { added: true, magazine, key };
    }
  },
  "magazine remove": {
    usage: "magazine remove <magazineKey|url> <noteKey|url>",
    summary: "Remove an article from your magazine",
    args: 2,
    async run({ positionals, client }) {
      const magazine = magazineKey(positionals[0]);
      const key = noteKey(positionals[1]);
      await addToMagazine(client, magazine, key, false);
      return { removed: true, magazine, key };
    }
  },
  notices: {
    usage: "notices",
    summary: "Unread notification and message counts",
    async run({ client }) {
      return noticeCounts(client);
    }
  },
  "membership plans": {
    usage: "membership plans",
    summary: "Your membership (\u30E1\u30F3\u30D0\u30FC\u30B7\u30C3\u30D7) plans",
    async run({ client }) {
      const plans = await membershipPlans(client);
      return { count: plans.length, plans };
    }
  },
  "membership joined": {
    usage: "membership joined",
    summary: "Memberships you belong to",
    async run({ client }) {
      return membershipSummaries(client);
    }
  }
};
async function finishLogin(cookies) {
  const probe = new NoteClient({ session: { cookies, savedAt: new Date().toISOString() } });
  const me = await currentUser(probe);
  const path = await saveSession({ cookies, urlname: me.urlname, userId: me.id, savedAt: new Date().toISOString() });
  return { loggedIn: true, urlname: me.urlname, nickname: me.nickname, sessionPath: path };
}
async function readArticleInput(file, values, client) {
  const source = file === "-" ? await readStdin() : await readFile4(file, "utf8").catch((e) => {
    throw new CliError("INVALID_INPUT", `Cannot read ${file}: ${e.message}`);
  });
  const baseDir = file === "-" ? process.cwd() : dirname2(resolve2(file));
  const parsed = parseArticle(source);
  const title = typeof values.title === "string" && values.title || parsed.title;
  if (!title)
    throw new CliError("INVALID_INPUT", "No title: add frontmatter `title:`, a leading `# Title`, or --title.");
  const images = new Map;
  const byPath = new Map;
  for (const src of imageRefs(parsed.markdown).filter(isLocalImageRef)) {
    const path = resolveImagePath(src, baseDir);
    const image = byPath.get(path) ?? await readImage(path);
    byPath.set(path, image);
    images.set(src, image);
  }
  const eyecatchFlag = typeof values.eyecatch === "string" ? values.eyecatch : null;
  const eyecatchSpec = eyecatchFlag ?? parsed.frontmatter.eyecatch ?? null;
  const eyecatch = !eyecatchSpec ? null : isStockPhotoRef(eyecatchSpec) ? await downloadStockPhoto(client, parseStockPhotoRef(eyecatchSpec)) : await readImage(eyecatchFlag ? resolve2(eyecatchFlag) : resolveImagePath(eyecatchSpec, baseDir));
  const links = blockLinks(parsed.markdown);
  const attachments = new Map;
  for (const href of links.files) {
    const path = resolveImagePath(href, baseDir);
    const info = await stat2(path).catch(() => null);
    if (!info?.isFile())
      throw new CliError("INVALID_INPUT", `Cannot attach ${href}: no such file (${path}). A link alone on its line to a local file becomes a download attachment.`);
    if (info.size > MAX_ATTACHMENT_BYTES)
      throw new CliError("INVALID_INPUT", `Cannot attach ${path}: larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    attachments.set(href, { path, bytes: new Uint8Array(await readFile4(path)), mimeType: attachmentMime(path) });
  }
  return { title, markdown: parsed.markdown, images, eyecatch, embedUrls: values["no-embed"] ? [] : links.urls, attachments };
}
var MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
function dryRunResult(input) {
  const preview = new Map([...input.images.keys()].map((src) => [src, src]));
  const { html, bodyLength, warnings } = markdownToNoteHtml(input.markdown, { images: preview });
  return {
    dryRun: true,
    title: input.title,
    html,
    bodyLength,
    images: [...input.images].map(([src, f]) => ({ src, path: f.path, mimeType: f.mimeType, bytes: f.bytes.length })),
    eyecatch: input.eyecatch ? {
      path: input.eyecatch.path,
      mimeType: input.eyecatch.mimeType,
      bytes: input.eyecatch.bytes.length,
      ...input.eyecatch.stockPhotoImageId ? { stockPhotoImageId: input.eyecatch.stockPhotoImageId } : {}
    } : null,
    ...input.embedUrls.length ? { embeds: input.embedUrls.map((url) => ({ url, service: embedService(url) ?? "decided by note (link card or player)" })) } : {},
    ...input.attachments.size ? { attachments: [...input.attachments.values()].map((f) => ({ path: f.path, mimeType: f.mimeType, bytes: f.bytes.length })) } : {},
    warnings: [
      ...warnings.filter((w2) => ![...input.attachments.keys()].some((href) => w2.startsWith(`Link "${href}"`))),
      ...input.eyecatch ? [eyecatchRatioWarning(input.eyecatch)].filter((w2) => !!w2) : []
    ]
  };
}
async function uploadImages(client, input) {
  const urls = new Map;
  const byPath = new Map;
  for (const [src, file] of input.images) {
    let url = byPath.get(file.path);
    if (!url) {
      url = (await uploadImage(client, file)).url;
      byPath.set(file.path, url);
    }
    urls.set(src, url);
  }
  return urls;
}
async function uploadAndConvert(client, input, noteKey2, uploaded) {
  const urls = uploaded ?? await uploadImages(client, input);
  const embeds = new Map;
  const blockWarnings = [];
  if (!noteKey2 && (input.embedUrls.length || input.attachments.size)) {
    blockWarnings.push("Embeds and attachments were skipped because the draft was given by numeric id; pass its key (n...) instead.");
  } else if (noteKey2) {
    for (const url of input.embedUrls) {
      try {
        embeds.set(url, await createEmbed(client, noteKey2, url));
      } catch (e) {
        if (!(e instanceof CliError) || e.code === "NOT_LOGGED_IN" || e.code === "AUTH_ERROR")
          throw e;
        blockWarnings.push(`Could not embed ${url} (${e.message}); left as a link.`);
      }
    }
    for (const [href, file] of input.attachments) {
      try {
        embeds.set(href, await uploadAttachment(client, noteKey2, file));
      } catch (e) {
        if (!(e instanceof CliError) || e.code === "NOT_LOGGED_IN" || e.code === "AUTH_ERROR")
          throw e;
        blockWarnings.push(`Could not attach ${file.path} (${e.message}); dropped.`);
      }
    }
  }
  const { html, bodyLength, warnings } = markdownToNoteHtml(input.markdown, { images: urls, embeds });
  return {
    title: input.title,
    html,
    bodyLength,
    warnings: [...blockWarnings, ...warnings],
    images: [...urls].map(([src, url]) => ({ src, url })),
    embeds: [...embeds.values()].map((e) => ({ service: e.service, url: e.url, key: e.key }))
  };
}
async function applyEyecatch(client, noteId, file, article) {
  if (!file)
    return { result: null, warnings: [] };
  const stock = file.stockPhotoImageId ? { stockPhotoImageId: file.stockPhotoImageId } : {};
  let url;
  try {
    ({ url } = await setEyecatch(client, noteId, file));
  } catch (e) {
    if (!(e instanceof CliError) || e.code === "NOT_LOGGED_IN")
      throw e;
    return {
      result: { path: file.path, set: false, url: null, ...stock },
      warnings: [`${e.message} The draft was saved without an eyecatch; fix the image and run \`draft update\` with --eyecatch.`]
    };
  }
  if (!file.stockPhotoImageId)
    return { result: { path: file.path, set: true, url }, warnings: [] };
  try {
    await saveDraft(client, noteId, article, stock);
    return { result: { path: file.path, set: true, url, ...stock }, warnings: [] };
  } catch (e) {
    if (!(e instanceof CliError) || e.code === "NOT_LOGGED_IN")
      throw e;
    return {
      result: { path: file.path, set: true, url },
      warnings: [`The gallery photo is the eyecatch, but crediting its creator failed (${e.message}). Rerun \`draft update\` with the same --eyecatch.`]
    };
  }
}
function imagesField(images, eyecatch, embeds = []) {
  return {
    ...images.length ? { images } : {},
    ...embeds.length ? { embeds } : {},
    ...eyecatch.result ? { eyecatch: eyecatch.result } : {}
  };
}
function list(value) {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw.filter((x2) => typeof x2 === "string").flatMap((x2) => x2.split(/[,\u3001]/)).map((x2) => x2.trim()).filter(Boolean);
}
function publishSettings(values) {
  const price = int(values.price, "price");
  if (price !== 0 && (price < 100 || price > 50000)) {
    throw new CliError("USAGE", "--price must be 0 (free) or between 100 and 50000 yen.");
  }
  let publishAt;
  if (typeof values.schedule === "string") {
    const at2 = new Date(values.schedule);
    if (Number.isNaN(at2.getTime())) {
      throw new CliError("USAGE", `--schedule is not a date/time: "${values.schedule}". Use e.g. 2026-12-01T09:00+09:00.`);
    }
    if (at2.getTime() < Date.now() + 5 * 60000)
      throw new CliError("USAGE", "--schedule must be at least 5 minutes in the future.");
    publishAt = at2.toISOString();
  }
  return {
    hashtags: [...new Set(list(values.hashtag).map(hashtag))],
    price,
    magazineKeys: [...new Set(list(values.magazine).map(magazineKey))],
    publishAt,
    notify: !values["no-notify"],
    toc: Boolean(values.toc),
    disableComments: Boolean(values["disable-comments"]),
    refund: Boolean(values.refund),
    hideFromProfile: Boolean(values["hide-from-profile"])
  };
}
function circlePermissions(choices, access) {
  if (choices.includes("none")) {
    if (choices.length > 1)
      throw new CliError("USAGE", "--membership none cannot be combined with other values.");
    return [];
  }
  const circle = access[0];
  if (!circle)
    throw new CliError("FORBIDDEN", "You have no membership (\u30E1\u30F3\u30D0\u30FC\u30B7\u30C3\u30D7) to publish the article to.");
  if (choices.includes("all")) {
    if (choices.length > 1)
      throw new CliError("USAGE", "--membership all already covers every plan; do not list plans with it.");
    return [{ kind: "circle", keys: [circle.circle.key] }];
  }
  const known = new Map(access.flatMap((a3) => a3.plans.map((p) => [p.key, p])));
  const unknown = choices.filter((c2) => !known.has(c2));
  if (unknown.length) {
    const plans = [...known.values()].map((p) => `${p.key}${p.name ? ` (${p.name})` : ""}`).join(", ") || "none";
    throw new CliError("USAGE", `Unknown membership plan: ${unknown.join(", ")}. Your plans: ${plans}.`);
  }
  return [{ kind: "circle_plan", keys: [...new Set(choices)] }];
}
function dashboardRangeFrom(values) {
  const period = oneOf(values.period, Object.keys(DASHBOARD_PERIODS), "period");
  const date = (x2, name) => {
    if (x2 === undefined)
      return;
    if (typeof x2 !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x2) || Number.isNaN(new Date(x2).getTime())) {
      throw new CliError("USAGE", `--${name} must be a date like 2026-10-01.`);
    }
    return x2;
  };
  const from = date(values.from, "from");
  const to = date(values.to, "to");
  if (period !== "custom" && (from || to))
    throw new CliError("USAGE", "--from/--to only apply with --period custom.");
  if (from && to && from > to)
    throw new CliError("USAGE", "--from must not be after --to.");
  return dashboardRange(period, { from, to });
}
function noteFromDraft(data) {
  const draft = data?.note_draft ?? {};
  const name = draft.name ?? data?.name;
  const body = draft.body ?? data?.body;
  if (typeof name !== "string" || !name.trim())
    throw new CliError("INVALID_INPUT", "The draft has no title; set one before publishing.");
  if (typeof body !== "string" || !body.trim())
    throw new CliError("INVALID_INPUT", "The draft has no body; save content before publishing.");
  return { name, body, slug: typeof data?.slug === "string" ? data.slug : null, key: typeof data?.key === "string" ? data.key : null };
}
async function savedNote(client, key) {
  const data = await getDraft(client, key);
  if (!data)
    throw new CliError("NOT_FOUND", `Could not find your article ${key}.`);
  return noteFromDraft(data);
}
function publishPreview(p) {
  return {
    title: p.name,
    status: p.status,
    publishAt: p.publish_at ?? null,
    price: p.price,
    hashtags: p.hashtags.map((h) => h.slice(1)),
    magazineKeys: p.magazine_keys,
    toc: p.index,
    disableComments: p.disable_comment,
    refund: p.is_refund,
    notify: p.send_notifications_flag,
    hideFromProfile: p.exclude_from_creator_top,
    ...p.circle_permissions ? { membership: p.circle_permissions } : {},
    bodyLength: p.body_length,
    freeLength: visibleTextLength(p.free_body),
    paidLength: visibleTextLength(p.pay_body),
    images: p.image_keys.length
  };
}
function publishError(res, settings) {
  const message = res.body?.error?.message ?? (typeof res.body === "string" ? res.body.slice(0, 300) : JSON.stringify(res.body ?? null).slice(0, 300));
  if (settings.publishAt && res.status === 422 && /\u4E88\u7D04/.test(message)) {
    return new CliError("FORBIDDEN", `note refused the scheduled post (${message}). Scheduled posting needs a note premium account.`, {
      status: res.status,
      detail: res.body
    });
  }
  const code = res.status === 401 ? "AUTH_ERROR" : "PUBLISH_FAILED";
  return new CliError(code, `Publishing failed: HTTP ${res.status}. ${message}`, { status: res.status, detail: { challenges: res.challenges, body: res.body } });
}
async function follow(client, urlname2, on) {
  const creator = await getCreator(client, urlname2);
  const userKey = creator?.key;
  if (typeof userKey !== "string")
    throw new CliError("NOT_FOUND", `Could not find creator "${urlname2}".`);
  await followUser(client, userKey, on);
  return { following: on, urlname: urlname2, nickname: creator?.nickname ?? null };
}
function parseImportedCookies(raw) {
  const s = raw.trim();
  const cookies = s.includes("=") ? parseCookieHeader(s) : s ? { _note_session_v5: s } : {};
  if (!cookies._note_session_v5) {
    throw new CliError("INVALID_INPUT", "Expected a Cookie header containing _note_session_v5, or the _note_session_v5 value itself.");
  }
  return cookies;
}
function bodyField(html, asHtml, maxChars) {
  const full = asHtml ? html : htmlToText(html);
  const chars = [...full];
  const truncated = maxChars > 0 && chars.length > maxChars;
  const body = truncated ? chars.slice(0, maxChars).join("") : full;
  return { ...asHtml ? { bodyHtml: body } : { bodyText: body }, bodyChars: chars.length, truncated };
}
function skippedField(skipped) {
  return skipped.length ? { skipped: { count: skipped.length, rows: skipped.slice(0, 10) } } : {};
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
    const result = await cmd.run({ values, positionals, client, deps });
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
