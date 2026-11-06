import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { circlePermissions, main, noteKey, parseImportedCookies } from "../src/cli.ts";
import { NoteClient } from "../src/client.ts";
import { parseCookieHeader } from "../src/session.ts";
import * as v from "../src/validate.ts";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

function fakeClient(responses: Array<{ status?: number; body: unknown; headers?: [string, string][] }>, cookies: Record<string, string> | null) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    calls.push({
      method: String(init.method),
      url: new URL(String(input)),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  const client = new NoteClient({
    session: cookies ? { cookies, savedAt: "test" } : null,
    fetchImpl,
    minIntervalMs: 0,
  });
  return { client, calls };
}

async function capture(fn: () => Promise<number>) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (s: string) => out.push(s);
  console.error = (s: string) => err.push(s);
  try {
    const code = await fn();
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("noteKey extracts keys from URLs and rejects anything else", () => {
  assert.equal(noteKey("https://note.com/u/n/n6a10366298b0"), "n6a10366298b0");
  assert.equal(noteKey("https://editor.note.com/notes/n6a10366298b0/edit/"), "n6a10366298b0");
  assert.equal(noteKey(" n6a10366298b0 "), "n6a10366298b0");
  for (const bad of ["123", "../etc", "n6a1/../x", "https://note.com/u", ""]) {
    assert.throws(() => noteKey(bad), /Not a note key/, bad);
  }
});

test("urlname, hashtag and id-or-key validation", () => {
  assert.equal(v.urlname("@marie_222"), "marie_222");
  assert.equal(v.urlname("https://note.com/marie_222/n/n6a10366298b0"), "marie_222");
  assert.throws(() => v.urlname("a/b"));
  assert.throws(() => v.urlname(".."));
  assert.equal(v.hashtag("#ClaudeCode"), "ClaudeCode");
  assert.equal(v.hashtag("note分析"), "note分析");
  for (const bad of ["..", ".", "a/b", "a?b", "a b", "#", "%2e%2e"]) assert.throws(() => v.hashtag(bad), bad);
  assert.deepEqual(v.noteIdOrKey("189694229"), { id: 189694229 });
  assert.deepEqual(v.noteIdOrKey("https://note.com/u/n/n4db206aeba44"), { key: "n4db206aeba44" });
});

test("auth import accepts a Cookie header or a bare session value", () => {
  assert.deepEqual(parseImportedCookies("abc123\n"), { _note_session_v5: "abc123" });
  assert.equal(parseImportedCookies("_note_session_v5=abc; XSRF-TOKEN=t")._note_session_v5, "abc");
  assert.throws(() => parseImportedCookies("XSRF-TOKEN=t"), /_note_session_v5/);
  assert.throws(() => parseImportedCookies("  "), /_note_session_v5/);
});

test("parseCookieHeader handles a DevTools-copied header", () => {
  assert.deepEqual(parseCookieHeader("Cookie: _note_session_v5=abc; XSRF-TOKEN=x%3Dy; a=b=c"), {
    _note_session_v5: "abc",
    "XSRF-TOKEN": "x%3Dy",
    a: "b=c",
  });
});

test("draft create creates an empty draft then saves the converted body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "note-cli-"));
  const file = join(dir, "post.md");
  await writeFile(file, "# タイトル\n\n本文");
  const { client, calls } = fakeClient(
    [{ body: { data: { id: 42, key: "nabcdef123456" } } }, { body: { data: { result: true } } }],
    { _note_session_v5: "s", "XSRF-TOKEN": "tok%3D" },
  );

  const r = await capture(() => main(["draft", "create", file], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.id, 42);
  assert.equal(out.editUrl, "https://editor.note.com/notes/nabcdef123456/edit/");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.pathname, "/api/v1/text_notes");
  assert.equal(calls[0].body.name, "タイトル");
  assert.equal(calls[0].headers["X-XSRF-TOKEN"], "tok=");
  assert.equal(calls[0].headers.Origin, "https://editor.note.com");
  assert.match(calls[0].headers.Cookie, /_note_session_v5=s/);

  assert.equal(calls[1].url.pathname, "/api/v1/text_notes/draft_save");
  assert.equal(calls[1].url.searchParams.get("id"), "42");
  assert.match(calls[1].body.body, /<p name="[^"]+" id="[^"]+">本文<\/p>/);
  assert.equal(calls[1].body.body_length, 2);
});

test("authenticated commands fail fast without a session and never hit the network", async () => {
  const { client, calls } = fakeClient([], null);
  const r = await capture(() => main(["stats", "pv"], { client }));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "NOT_LOGGED_IN");
  assert.equal(calls.length, 0);
});

test("HTTP 401 maps to AUTH_ERROR", async () => {
  const { client } = fakeClient([{ status: 401, body: { error: "x" } }], { _note_session_v5: "s" });
  const r = await capture(() => main(["stats", "pv"], { client }));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "AUTH_ERROR");
});

test("search paginates until the limit and stops at the last page", async () => {
  const note = (i: number) => ({ key: `n${i}`, name: `t${i}`, like_count: i, price: 0, user: { urlname: "u" } });
  const { client, calls } = fakeClient(
    [
      { body: { data: { notes: { contents: Array.from({ length: 20 }, (_, i) => note(i)), is_last_page: false, total_count: 25 } } } },
      { body: { data: { notes: { contents: Array.from({ length: 5 }, (_, i) => note(20 + i)), is_last_page: true, total_count: 25 } } } },
    ],
    null,
  );
  const r = await capture(() => main(["search", "AI", "--limit", "50"], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 25);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get("start"), "20");
  assert.equal(calls[0].headers.Cookie, undefined);
});

test("draft delete requires --yes", async () => {
  const { client, calls } = fakeClient([], { _note_session_v5: "s" });
  const r = await capture(() => main(["draft", "delete", "42"], { client }));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "CONFIRMATION_REQUIRED");
  assert.equal(calls.length, 0);
});

test("invalid enum option is a usage error", async () => {
  const { client } = fakeClient([], null);
  const r = await capture(() => main(["search", "x", "--sort", "bogus"], { client }));
  assert.equal(r.code, 2);
});

test("search stops on total_count when is_last_page is always null", async () => {
  const note = (i: number) => ({ key: `nkey${String(i).padStart(4, "0")}`, name: `t${i}`, like_count: i, user: { urlname: "u" } });
  const { client, calls } = fakeClient(
    [
      { body: { data: { notes: { contents: Array.from({ length: 20 }, (_, i) => note(i)), is_last_page: null, total_count: 23 } } } },
      { body: { data: { notes: { contents: Array.from({ length: 3 }, (_, i) => note(20 + i)), is_last_page: null, total_count: 23 } } } },
      { body: { data: { notes: { contents: [], is_last_page: null, total_count: 23 } } } },
    ],
    null,
  );
  const r = await capture(() => main(["search", "AI", "--limit", "100"], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 23);
  assert.equal(out.exhausted, true);
  assert.equal(calls.length, 2);
});

test("unreadable rows are skipped and reported", async () => {
  const { client } = fakeClient(
    [{ body: { data: { notes: { contents: [{ key: "nabcdef1", name: "ok" }, { name: "no key" }], total_count: 2 } } } }],
    null,
  );
  const r = await capture(() => main(["search", "AI"], { client }));
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 1);
  assert.equal(out.skipped.count, 1);
  assert.equal(out.skipped.rows[0].reason, "missing key");
});

test("note truncates long bodies and reports hashtags from hashtag_notes", async () => {
  const body = `<p>${"あ".repeat(50)}</p>`;
  const { client } = fakeClient(
    [{ body: { data: { key: "nabcdef1", name: "T", body, user: { urlname: "u" }, hashtag_notes: [{ hashtag: { name: "#x" } }] } } }],
    null,
  );
  const r = await capture(() => main(["note", "nabcdef1", "--max-chars", "10"], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bodyText, "あ".repeat(10));
  assert.equal(out.bodyChars, 50);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.hashtags, ["x"]);
});

test("invalid hashtag is rejected before any request", async () => {
  const { client, calls } = fakeClient([], null);
  const r = await capture(() => main(["hashtag", ".."], { client }));
  assert.equal(r.code, 2);
  assert.equal(calls.length, 0);
});

function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

async function articleWithImages() {
  const dir = await mkdtemp(join(tmpdir(), "note-cli-"));
  await writeFile(join(dir, "a.png"), pngBytes(10, 10));
  await writeFile(join(dir, "cover.png"), pngBytes(1280, 670));
  const file = join(dir, "post.md");
  await writeFile(file, "---\ntitle: T\neyecatch: cover.png\n---\n\n![one](a.png)\n\n![again](./a.png)\n");
  return { dir, file };
}

const presign = {
  body: {
    data: {
      url: "https://assets.st-note.com/img/1.png",
      action: "https://bucket.s3.amazonaws.com",
      post: { key: "img/1.png", policy: "p", "x-amz-signature": "s" },
    },
  },
};

test("draft create uploads each local image once, embeds it, and sets the eyecatch", async () => {
  const { file } = await articleWithImages();
  const { client, calls } = fakeClient(
    [
      presign,
      { status: 204, body: "" },
      { body: { data: { id: 42, key: "nabcdef123456" } } },
      { body: { data: { result: true } } },
      { body: { data: { url: "https://assets.st-note.com/eye.png" } } },
    ],
    { _note_session_v5: "s", "XSRF-TOKEN": "tok" },
  );
  const r = await capture(() => main(["draft", "create", file], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`), [
    "POST note.com/api/v3/images/upload/presigned_post",
    "POST bucket.s3.amazonaws.com/",
    "POST note.com/api/v1/text_notes",
    "POST note.com/api/v1/text_notes/draft_save",
    "POST note.com/api/v1/image_upload/note_eyecatch",
  ]);
  assert.equal((calls[0].body as FormData).get("filename"), "a.png");
  const s3 = calls[1].body as FormData;
  assert.deepEqual([...s3.keys()], ["key", "policy", "x-amz-signature", "file"]);
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal((calls[4].body as FormData).get("note_id"), "42");

  const html: string = calls[3].body.body;
  assert.equal(html.match(/<figure /g)?.length, 2);
  assert.match(html, /<img src="https:\/\/assets.st-note.com\/img\/1.png" alt="one"/);
  assert.equal(out.images.length, 2);
  assert.deepEqual(out.eyecatch, { path: out.eyecatch.path, set: true, url: "https://assets.st-note.com/eye.png" });
  assert.deepEqual(out.warnings, []);
});

test("a rejected eyecatch (HTTP 200 with an error body) becomes a warning, not a failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "note-cli-"));
  await writeFile(join(dir, "small.png"), pngBytes(320, 200));
  const file = join(dir, "post.md");
  await writeFile(file, "# T\n\nbody");
  const { client } = fakeClient(
    [
      { body: { data: { id: 42, key: "nabcdef123456" } } },
      { body: { data: { result: true } } },
      { body: { error: { code: "invalid", message: "見出し画像は1280:670の縦横比の画像を設定してください" } } },
    ],
    { _note_session_v5: "s" },
  );
  const r = await capture(() => main(["draft", "create", file, "--eyecatch", join(dir, "small.png")], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.id, 42);
  assert.equal(out.eyecatch.set, false);
  assert.match(out.warnings[0], /1280:670/);
});

test("draft --dry-run validates images without any request", async () => {
  const { file } = await articleWithImages();
  const { client, calls } = fakeClient([], null);
  const r = await capture(() => main(["draft", "create", file, "--dry-run"], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(calls.length, 0);
  assert.deepEqual(out.images.map((i: any) => i.src), ["a.png", "./a.png"]);
  assert.match(out.html, /<img src="a.png"/);
  assert.equal(out.eyecatch.mimeType, "image/png");

  await writeFile(file, "# T\n\n![x](missing.png)");
  const bad = await capture(() => main(["draft", "create", file, "--dry-run"], { client }));
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_INPUT");
});

test("search --type user returns creators", async () => {
  const { client, calls } = fakeClient(
    [{ body: { data: { users: { contents: [{ id: 1, urlname: "abc", nickname: "A", follower_count: 5 }, { nickname: "no urlname" }], total_count: 2, is_last_page: null } } } }],
    null,
  );
  const r = await capture(() => main(["search", "AI", "--type", "user"], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(calls[0].url.searchParams.get("context"), "user");
  assert.equal(out.users[0].url, "https://note.com/abc");
  assert.equal(out.users[0].followerCount, 5);
  assert.equal(out.skipped.count, 1);
});

test("likes pages through is_last_page and reports the total", async () => {
  const like = (i: number) => ({ created_at: "2026-01-01", user: { urlname: `u${i}`, nickname: `U${i}`, follower_count: i } });
  const { client, calls } = fakeClient(
    [
      { body: { data: { likes: Array.from({ length: 50 }, (_, i) => like(i)), extra_fields: { like_count: 53 } }, is_last_page: false } },
      { body: { data: { likes: Array.from({ length: 3 }, (_, i) => like(50 + i)), extra_fields: { like_count: 53 } }, is_last_page: true } },
    ],
    null,
  );
  const r = await capture(() => main(["likes", "https://note.com/u/n/nabcdef123456", "--limit", "100"], { client }));
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 53);
  assert.equal(out.total, 53);
  assert.equal(out.exhausted, true);
  assert.equal(calls[1].url.searchParams.get("page"), "2");
  assert.equal(calls[0].url.pathname, "/api/v3/notes/nabcdef123456/likes");
});

test("comments flattens the comment tree to text", async () => {
  const comment = {
    key: "nc1",
    comment: { type: "root", children: [{ type: "element", tag_name: "p", children: [{ type: "text", value: "Hello" }] }, { type: "element", tag_name: "p", children: [{ type: "text", value: "World" }] }] },
    user: { urlname: "u", nickname: "U" },
    like_count: 2,
    reply_count: 1,
    is_creator_replied: true,
  };
  const { client, calls } = fakeClient([{ body: { data: [comment], total_count: 1, next_page: null } }], null);
  const r = await capture(() => main(["comments", "nabcdef123456"], { client }));
  const out = JSON.parse(r.stdout);
  assert.equal(calls[0].url.pathname, "/api/v3/notes/nabcdef123456/note_comments");
  assert.equal(out.comments[0].text, "Hello\nWorld");
  assert.equal(out.comments[0].creatorReplied, true);
  assert.equal(out.exhausted, true);
});

test("contests filters by state and type and sorts by closing date", async () => {
  const c = (id: number, type: string, state: string, closeAt: string) => ({ id, name: `#c${id}`, type, state, closeAt, hashtag: { name: `#c${id}` } });
  const { client } = fakeClient(
    [{ body: { data: { contests: [c(1, "theme", "opened", "2999/01/01 00:00"), c(2, "contest", "opened", "2026/12/01 00:00"), c(3, "contestLight", "opened", "2026/11/10 00:00"), c(4, "contest", "finished", "2025/01/01 00:00")] } } }],
    null,
  );
  const r = await capture(() => main(["contests", "--type", "contest"], { client }));
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.contests.map((x: any) => x.id), [3, 2]);
  assert.equal(out.contests[0].hashtag, "c3");
});

test("hashtag includes the tag's article count and related tags", async () => {
  const { client, calls } = fakeClient(
    [
      { body: { data: { name: "#AI", count: 100, relatedHashtags: [{ name: "#ChatGPT", count: 5 }] } } },
      { body: { data: { notes: [], count: 0, is_last_page: true } } },
    ],
    null,
  );
  const r = await capture(() => main(["hashtag", "AI"], { client }));
  const out = JSON.parse(r.stdout);
  assert.equal(calls[0].url.pathname, "/api/v2/hashtags/AI");
  assert.equal(out.articleCount, 100);
  assert.equal(out.relatedHashtags[0].name, "ChatGPT");
});

test("magazine and category identifiers are validated before any request", async () => {
  assert.equal(v.magazineKey("https://note.com/u/m/m97e554a23b24"), "m97e554a23b24");
  assert.equal(v.magazineKey("m97e554a23b24"), "m97e554a23b24");
  assert.throws(() => v.magazineKey("n97e554a23b24"));
  assert.equal(v.categorySlug("Tech"), "tech");
  for (const bad of ["../x", "a/b", ""]) assert.throws(() => v.categorySlug(bad), /category slug/);
  const { client, calls } = fakeClient([], null);
  const r = await capture(() => main(["magazine", "../etc"], { client }));
  assert.equal(r.code, 2);
  assert.equal(calls.length, 0);
});

// ---------------- publishing & actions ----------------

const SESSION = { _note_session_v5: "s", "XSRF-TOKEN": "tok" };
const DRAFT = { data: { id: 7, key: "nabcdef123456", status: "draft", name: "Title", body: '<p name="p1" id="p1">hello</p>', user: { urlname: "me" } } };

function fakePublisher(result: { status: number; body?: unknown }) {
  const calls: any[] = [];
  const publish = (async (opts: any) => {
    calls.push(opts);
    return { challenges: ["reCAPTCHAv3"], verification: 200, body: {}, ...result };
  }) as any;
  return { publish, calls };
}

test("publish requires --yes and touches nothing without it", async () => {
  const { client, calls } = fakeClient([], SESSION);
  const pub = fakePublisher({ status: 200 });
  const r = await capture(() => main(["publish", "nabcdef123456"], { client, publish: pub.publish }));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "CONFIRMATION_REQUIRED");
  assert.equal(calls.length + pub.calls.length, 0);
});

test("publish sends the saved draft through the browser publisher", async () => {
  const { client, calls } = fakeClient([{ body: DRAFT }], SESSION);
  const pub = fakePublisher({ status: 200 });
  const r = await capture(() =>
    main(["publish", "https://note.com/me/n/nabcdef123456", "--yes", "--hashtag", "AI,note", "--hashtag", "#AI", "--toc"], { client, publish: pub.publish }),
  );
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.published, true);
  assert.equal(out.url, "https://note.com/me/n/nabcdef123456");
  assert.equal(calls.length, 1);
  assert.equal(pub.calls[0].noteId, 7);
  assert.deepEqual(pub.calls[0].cookies, SESSION);
  assert.deepEqual(pub.calls[0].payload.hashtags, ["#AI", "#note"]);
  assert.equal(pub.calls[0].payload.index, true);
  assert.equal(pub.calls[0].payload.free_body, DRAFT.data.body);
});

test("publish --dry-run on a file needs no session or network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "note-cli-"));
  const file = join(dir, "a.md");
  await writeFile(file, "# T\n\nfree\n\n<!-- paywall -->\n\npaid");
  const { client, calls } = fakeClient([], null);
  const r = await capture(() => main(["publish", "nabcdef123456", file, "--dry-run", "--price", "500"], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.price, out.freeLength, out.paidLength], [500, 4, 4]);
  assert.equal(calls.length, 0);
});

test("publish validates price and schedule before any request", async () => {
  const { client, calls } = fakeClient([], SESSION);
  for (const args of [["--price", "50"], ["--schedule", "yesterday"], ["--schedule", "2000-01-01T00:00Z"]]) {
    const r = await capture(() => main(["publish", "nabcdef123456", "--yes", ...args], { client }));
    assert.equal(r.code, 2, args.join(" "));
  }
  assert.equal(calls.length, 0);
});

test("a refused scheduled post explains the premium requirement", async () => {
  const { client } = fakeClient([{ body: DRAFT }], SESSION);
  const pub = fakePublisher({ status: 422, body: { error: { code: "invalid", message: "予約投稿はできません" } } });
  const at = new Date(Date.now() + 86400e3).toISOString();
  const r = await capture(() => main(["publish", "nabcdef123456", "--yes", "--schedule", at], { client, publish: pub.publish }));
  assert.equal(r.code, 1);
  const err = JSON.parse(r.stderr).error;
  assert.equal(err.code, "FORBIDDEN");
  assert.match(err.message, /premium/);
  assert.equal(pub.calls[0].payload.status, "reserved");
});

test("delete unpublishes a published article before deleting it", async () => {
  const { client, calls } = fakeClient([{ body: { data: { ...DRAFT.data, status: "published" } } }, { body: { data: "success" } }, { body: {} }], SESSION);
  const r = await capture(() => main(["delete", "nabcdef123456", "--yes"], { client }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url.pathname}`),
    ["GET /api/v3/notes/nabcdef123456", "POST /api/v2/notes/nabcdef123456/change_status", "DELETE /api/v1/text_notes/draft_delete"],
  );
  assert.deepEqual(calls[1].body, { status: "draft" });
  assert.equal(JSON.parse(r.stdout).wasStatus, "published");
});

test("follow resolves the creator's user key", async () => {
  const { client, calls } = fakeClient([{ body: { data: { key: "0f94d557eb41fa628cd9ce997a8fbb18", nickname: "N" } } }, { body: {} }], SESSION);
  const r = await capture(() => main(["follow", "@someone"], { client }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url.pathname, "/api/v3/users/0f94d557eb41fa628cd9ce997a8fbb18/following");
});

test("like, magazine add and magazine remove hit the right endpoints", async () => {
  const { client, calls } = fakeClient([], SESSION);
  for (const argv of [["like", "nabcdef123456"], ["unlike", "nabcdef123456"], ["magazine", "add", "m1234567", "nabcdef123456"], ["magazine", "remove", "m1234567", "nabcdef123456"]]) {
    const r = await capture(() => main(argv, { client }));
    assert.equal(r.code, 0, r.stderr);
  }
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), [
    "POST /api/v3/notes/nabcdef123456/likes",
    "DELETE /api/v3/notes/nabcdef123456/likes",
    "POST /api/v1/our/magazines/m1234567/notes",
    "DELETE /api/v1/our/magazines/m1234567/notes/nabcdef123456",
  ]);
  assert.deepEqual(calls[2].body, { note_key: "nabcdef123456" });
});

test("comment sends an AST and explains the guideline gate", async () => {
  const { client, calls } = fakeClient(
    [{ status: 403, body: { error: { type: "comment_acknowledgement", message: "コメントのガイドラインが追加されました。" } } }],
    SESSION,
  );
  const r = await capture(() => main(["comment", "nabcdef123456", "hi", "there"], { client }));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "COMMENT_GUIDELINES");
  assert.equal(calls[0].body.comment.children[0].children[0].value, "hi there");
});

test("a 403 that carries a message is a refusal, not an expired session", async () => {
  const { client } = fakeClient([{ status: 403, body: { data: "以下の記事は下書きに戻すことができません。<br/>・有料記事" } }], SESSION);
  const r = await capture(() => main(["unpublish", "nabcdef123456", "--yes"], { client }));
  const err = JSON.parse(r.stderr).error;
  assert.equal(err.code, "FORBIDDEN");
  assert.match(err.message, /下書きに戻すことができません。 ・有料記事/);
  assert.doesNotMatch(err.message, /auth login/);
});

test("draft create turns lone URLs into embeds and lone local-file links into attachments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "note-cli-"));
  const file = join(dir, "post.md");
  await writeFile(join(dir, "doc.pdf"), "%PDF-1.1");
  await writeFile(
    file,
    "# T\n\nhttps://www.youtube.com/watch?v=abc\n\nhttps://note.com/someone/n/n0123456789ab\n\n[資料](doc.pdf)\n\nsee [a link](https://x.com/y) inline\n\nhttps://example.com/broken",
  );
  const { client, calls } = fakeClient(
    [
      { body: { data: { id: 42, key: "nabcdef123456" } } },
      { body: { data: { key: "embyt", html_for_embed: "<span></span>" } } },
      { body: { data: { embedded_content: { key: "embnote" } } } },
      { body: { data: { type: null } } },
      { status: 400, body: { data: { error: "指定された URL の内容を取得できませんでした" } } },
      { body: { data: { attachment_key: "a".repeat(32), embedded_content_key: "embfile", html_for_embed: '<div class="file-widget"><strong class="file-widget__filename">doc.pdf</strong></div>' } } },
      { body: { data: { result: true } } },
    ],
    SESSION,
  );
  const r = await capture(() => main(["draft", "create", file], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.embeds.map((e: any) => e.service), ["youtube", "note", "attachment"]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Could not embed https:\/\/example.com\/broken/);

  assert.equal(calls[0].url.pathname, "/api/v1/text_notes");
  assert.equal(calls[1].url.pathname, "/api/v2/embed_by_external_api");
  assert.equal(calls[1].url.searchParams.get("service"), "youtube");
  assert.equal(calls[1].url.searchParams.get("embeddable_key"), "nabcdef123456");
  assert.equal(calls[2].url.pathname, "/api/v1/embed");
  assert.equal((calls[2].body as FormData).get("embeddable_key"), "nabcdef123456");
  assert.equal(calls[3].url.pathname, "/api/v2/embed_by_external_api/check_type");
  assert.equal(calls[4].url.searchParams.get("service"), "external-article");
  assert.equal(calls[5].url.pathname, "/api/v2/attachments/upload");
  assert.equal((calls[5].body as FormData).get("note_key"), "nabcdef123456");

  const body: string = calls[6].body.body;
  assert.match(body, /<figure data-src="https:\/\/www.youtube.com\/watch\?v=abc" data-identifier="null" embedded-service="youtube" embedded-content-key="embyt" name="[^"]+" id="[^"]+"><\/figure>/);
  assert.match(body, /data-identifier="n0123456789ab" embedded-service="note" embedded-content-key="embnote"/);
  assert.match(body, /embedded-service="attachment" embedded-content-key="embfile"[^>]*><div class="file-widget">/);
  assert.match(body, /<a href="https:\/\/x.com\/y">a link<\/a>/);
  assert.match(body, /<a href="https:\/\/example.com\/broken">/);
  // Widget text inside embeds does not count toward the article length.
  assert.equal(calls[6].body.body_length, [..."see a link inline", ..."https://example.com/broken"].length);
});

test("--no-embed keeps URLs as links and a missing attachment fails before any request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "note-cli-"));
  const file = join(dir, "post.md");
  await writeFile(file, "# T\n\nhttps://www.youtube.com/watch?v=abc");
  const r = await capture(() => main(["draft", "create", file, "--no-embed", "--dry-run"]));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).embeds, undefined);

  await writeFile(file, "# T\n\n[資料](missing.pdf)");
  const { client, calls } = fakeClient([], SESSION);
  const r2 = await capture(() => main(["draft", "create", file], { client }));
  assert.equal(r2.code, 1);
  assert.match(JSON.parse(r2.stderr).error.message, /Cannot attach missing.pdf/);
  assert.equal(calls.length, 0);
});

test("stats dashboard gets a GraphQL token, then sends it as a bearer token", async () => {
  const token = ["set-cookie", "note_gql_auth_token=jwt123; path=/; secure"] as [string, string];
  const { client, calls } = fakeClient(
    [
      { status: 201, body: "", headers: [token] },
      { body: { data: { dashboardSummary: { lastUpdatedAt: "t", metrics: { pageViewCount: 10, impressionCount: null, likeCount: 2, commentCount: 0, salesAmount: 300 } } } } },
      { status: 201, body: "", headers: [token] },
      { body: { data: { dashboardNoteReferrersChart: { legend: [{ name: "note.com", count: 7 }] } } } },
      { status: 201, body: "", headers: [token] },
      {
        body: {
          data: {
            dashboardNoteListConnection: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              edges: [{ node: { note: { key: "n1", title: "A", status: "published", publishedAt: "p", link: { absoluteUrl: "u" } }, metrics: { pageViewCount: 10 } } }],
            },
          },
        },
      },
    ],
    SESSION,
  );
  const r = await capture(() => main(["stats", "dashboard", "--period", "7d", "--order", "likes", "--limit", "1"], { client }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.totals, { pageViews: 10, impressions: null, likes: 2, comments: 0, sales: 300 });
  assert.deepEqual(out.referrers, [{ name: "note.com", count: 7 }]);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].key, "n1");

  assert.equal(calls[0].url.pathname, "/api/v3/graphql/auth");
  assert.equal(calls[1].url.href, "https://graphql.note.com/graphql");
  assert.equal(calls[1].headers.Authorization, "Bearer jwt123");
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(calls[1].body.variables.unit, "LAST_7_DAYS");
  assert.equal(calls[5].body.variables.order, "LIKE_COUNT_DESC");
  assert.equal(calls[5].body.variables.first, 1);
});

test("stats dashboard validates the period before any request", async () => {
  const { client, calls } = fakeClient([], SESSION);
  for (const args of [["--period", "custom"], ["--period", "7d", "--from", "2026-01-01"], ["--period", "custom", "--from", "2026-02-01", "--to", "2026-01-01"], ["--period", "week"]]) {
    const r = await capture(() => main(["stats", "dashboard", ...args], { client }));
    assert.equal(r.code, 2, args.join(" "));
  }
  assert.equal(calls.length, 0);
});

test("publish --membership maps all/plans/none to circle_permissions", async () => {
  const access = [{ circle: { key: "c1", name: "M" }, plans: [{ key: "p1", name: "A" }, { key: "p2", name: null }] }];
  assert.deepEqual(circlePermissions(["all"], access), [{ kind: "circle", keys: ["c1"] }]);
  assert.deepEqual(circlePermissions(["p1", "p2", "p1"], access), [{ kind: "circle_plan", keys: ["p1", "p2"] }]);
  assert.deepEqual(circlePermissions(["none"], []), []);
  assert.throws(() => circlePermissions(["p3"], access), /Unknown membership plan: p3\. Your plans: p1 \(A\), p2/);
  assert.throws(() => circlePermissions(["all", "p1"], access), /already covers/);
  assert.throws(() => circlePermissions(["all"], []), /no membership/);

  const { client } = fakeClient(
    [{ body: { data: [{ circle: { key: "c1" }, circle_plans: [{ key: "p1" }] }] } }, { body: DRAFT }],
    SESSION,
  );
  const pub = fakePublisher({ status: 200 });
  const r = await capture(() => main(["publish", "nabcdef123456", "--yes", "--membership", "p1", "--hide-from-profile"], { client, publish: pub.publish }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pub.calls[0].payload.circle_permissions, [{ kind: "circle_plan", keys: ["p1"] }]);
  assert.equal(pub.calls[0].payload.exclude_from_creator_top, true);
  assert.equal(pub.calls[0].payload.slug, "slug-nabcdef123456");
});
