import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, noteKey } from "../src/cli.ts";
import { NoteClient } from "../src/client.ts";
import { parseCookieHeader } from "../src/session.ts";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

function fakeClient(responses: Array<{ status?: number; body: unknown }>, cookies: Record<string, string> | null) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    calls.push({
      method: String(init.method),
      url: new URL(String(input)),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
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

test("noteKey extracts keys from URLs and passes through other input", () => {
  assert.equal(noteKey("https://note.com/u/n/n6a10366298b0"), "n6a10366298b0");
  assert.equal(noteKey("https://editor.note.com/notes/n6a10366298b0/edit/"), "n6a10366298b0");
  assert.equal(noteKey("n6a10366298b0"), "n6a10366298b0");
  assert.equal(noteKey("123"), "123");
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
