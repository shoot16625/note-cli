import { launchBrowser, sleep } from "./browser.ts";
import { CliError } from "./client.ts";
import { visibleTextLength } from "./markdown.ts";

export interface PublishSettings {
  hashtags: string[];
  /** Yen; 0 = free. Paid articles need a paywall line in the body. */
  price: number;
  magazineKeys: string[];
  /** ISO 8601 time for a scheduled post; omitted = publish now. */
  publishAt?: string;
  /** Notify followers. */
  notify: boolean;
  /** Show a table of contents. */
  toc: boolean;
  disableComments: boolean;
  /** Allow refunds on a paid article. */
  refund: boolean;
  /** Keep the article off your profile's article list (it stays reachable by URL, magazines and search). */
  hideFromProfile?: boolean;
  /**
   * Membership plans that may read the article (`circle_permissions`); [] removes it from your
   * membership; undefined leaves note's default.
   */
  circlePermissions?: CirclePermission[];
}

export interface CirclePermission {
  /** "circle" = every member, "circle_plan" = only the listed plans. */
  kind: "circle" | "circle_plan";
  keys: string[];
}

const VOID_TAGS = new Set(["br", "img", "hr", "input", "source", "wbr"]);

/** Split note body HTML into its top-level elements. */
export function topLevelBlocks(html: string): string[] {
  const blocks: string[] = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let depth = 0;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    const [, closing, nameRaw, selfClosing] = m;
    const name = nameRaw.toLowerCase();
    if (closing) depth--;
    else if (!selfClosing && !VOID_TAGS.has(name)) depth++;
    if (depth === 0) {
      const block = html.slice(start, tag.lastIndex).trim();
      if (block) blocks.push(block);
      start = tag.lastIndex;
    }
  }
  const tail = html.slice(start).trim();
  if (tail) blocks.push(tail);
  return blocks;
}

const isPaywall = (block: string) => /^<paywall-line\b/i.test(block);

/** The key note uses for an uploaded image: a 32-hex id in the file name, else the name without extension. */
export function imageKey(src: string): string | null {
  try {
    const last = new URL(src).pathname.split("/").pop() ?? "";
    return last.match(/[a-f0-9]{32}/)?.[0] ?? last.match(/[^.]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the body of `PUT /v1/text_notes/{id}` the way note's publish page does: the body is
 * split at the paywall line into free/paid parts, and `separator` names the last free block.
 */
export function buildPublishPayload(note: { name: string; body: string; slug?: string | null; key?: string | null }, s: PublishSettings) {
  const blocks = topLevelBlocks(note.body);
  const paywallAt = blocks.findIndex(isPaywall);
  const content = blocks.filter((b) => !isPaywall(b));
  let separator: string | null = null;
  if (paywallAt > 0) {
    separator = blocks[paywallAt - 1].match(/\sname="([^"]+)"/)?.[1] ?? null;
    if (!separator) throw new CliError("INVALID_INPUT", "The block before the paywall line has no name attribute; re-save the draft with note-cli.");
  }
  if (s.price > 0 && !separator) {
    throw new CliError(
      "INVALID_INPUT",
      "A paid article needs a paywall: put `<!-- paywall -->` in the Markdown where the paid part starts (or place the line in the editor).",
    );
  }
  const freeCount = separator && s.price > 0 ? paywallAt : content.length;
  const imageKeys = content
    .flatMap((b) => [...b.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => imageKey(m[1])))
    .filter((k): k is string => !!k);
  const html = content.join("");
  return {
    author_ids: [],
    body_length: visibleTextLength(html),
    disable_comment: s.disableComments,
    exclude_from_creator_top: Boolean(s.hideFromProfile),
    exclude_ai_learning_reward: false,
    free_body: content.slice(0, freeCount).join(""),
    pay_body: content.slice(freeCount).join(""),
    hashtags: s.hashtags.map((h) => `#${h.replace(/^[#＃]/, "")}`),
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
    // An empty slug makes note fail with a bare 500 (notably for scheduled posts); the editor uses slug-<key>.
    ...(note.slug || note.key ? { slug: note.slug || `slug-${note.key}` } : {}),
    ...(s.circlePermissions ? { circle_permissions: s.circlePermissions } : {}),
    status: s.publishAt ? "reserved" : "published",
    ...(s.publishAt ? { publish_at: s.publishAt } : {}),
    discount_campaigns: [],
  };
}

/** reCAPTCHA Enterprise site key used by note's publish page. */
const RECAPTCHA_SITE_KEY = "6LefXTAsAAAAADYVISEItAl0IX1rgSGQ-asNy56w";

/**
 * Runs inside the editor page: the same sequence note's publish button performs.
 * 1. ask which challenges `note_post` needs, 2. pass reCAPTCHA v3 if asked, 3. PUT the note.
 */
const PAGE_SCRIPT = `async ({ noteId, payload, xsrf, siteKey }) => {
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

export interface BrowserPublishResult {
  challenges: string[];
  verification: number | null;
  status: number;
  body: any;
}

/**
 * Publish through a real browser window: note requires reCAPTCHA v3 for publishing, which only
 * a browser can pass. The browser gets the saved session cookies in a throwaway profile.
 */
export async function publishInBrowser(opts: {
  cookies: Record<string, string>;
  noteId: number;
  noteKey: string;
  payload: unknown;
  browser?: string;
  timeoutSec: number;
}): Promise<BrowserPublishResult> {
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
        sameSite: "Lax",
      })),
    });
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page");
    if (!page) throw new CliError("BROWSER_LAUNCH_FAILED", "The browser opened no page.");
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await cdp.send("Page.navigate", { url: `https://editor.note.com/notes/${opts.noteKey}/publish/` }, sessionId);

    const evaluate = async <T>(expression: string, awaitPromise = false): Promise<T> => {
      const r = await cdp.send<any>("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId);
      if (r.exceptionDetails) {
        throw new CliError("PUBLISH_FAILED", `Browser script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      }
      return r.result?.value as T;
    };

    const deadline = Date.now() + opts.timeoutSec * 1000;
    while ((await evaluate<string>("location.host + ' ' + document.readyState").catch(() => "")) !== "editor.note.com complete") {
      if (Date.now() > deadline) throw new CliError("PUBLISH_FAILED", "Timed out loading the note editor in the browser.");
      await sleep(500);
    }
    if (await evaluate<boolean>("location.pathname.startsWith('/login') || location.host === 'note.com'")) {
      throw new CliError("AUTH_ERROR", "The browser was not logged in; run `note-cli auth login` again.");
    }
    const args = JSON.stringify({
      noteId: opts.noteId,
      payload: opts.payload,
      xsrf: opts.cookies["XSRF-TOKEN"] ? safeDecode(opts.cookies["XSRF-TOKEN"]) : null,
      siteKey: RECAPTCHA_SITE_KEY,
    });
    return await evaluate<BrowserPublishResult>(`(${PAGE_SCRIPT})(${args})`, true);
  } finally {
    await close();
  }
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
