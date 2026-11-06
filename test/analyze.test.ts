import assert from "node:assert/strict";
import { test } from "bun:test";
import { analyzeNotes, numberStats } from "../src/analyze.ts";
import { normalizeNotes, tryNormalizeNote, type NoteSummary } from "../src/normalize.ts";

function normalizeNote(raw: unknown): NoteSummary {
  const n = tryNormalizeNote(raw);
  if (typeof n === "string") throw new Error(n);
  return n;
}

test("numberStats handles empty and odd-sized input", () => {
  assert.deepEqual(numberStats([]), { count: 0, mean: 0, median: 0, p90: 0, max: 0, min: 0 });
  const s = numberStats([5, 1, 3]);
  assert.equal(s.median, 3);
  assert.equal(s.mean, 3);
  assert.equal(s.max, 5);
  assert.equal(s.min, 1);
});

test("normalizeNote accepts snake_case (v3 search) payloads", () => {
  const n = normalizeNote({
    id: 1,
    key: "nabc",
    name: "T",
    like_count: 10,
    comment_count: 2,
    price: 500,
    publish_at: "2026-10-20T20:30:00.000+09:00",
    user: { urlname: "u", nickname: "U" },
    image_count: 3,
  });
  assert.equal(n.url, "https://note.com/u/n/nabc");
  assert.equal(n.likeCount, 10);
  assert.equal(n.isPaid, true);
  assert.equal(n.imageCount, 3);
});

test("normalizeNote accepts camelCase (v2 creator) payloads with hashtags", () => {
  const n = normalizeNote({
    key: "nxyz",
    name: "T",
    likeCount: 7,
    price: 0,
    publishAt: "2026-01-01T00:00:00.000+09:00",
    noteUrl: "https://note.com/u/n/nxyz",
    user: { urlname: "u" },
    hashtags: [{ hashtag: { name: "#AI" } }, { hashtag: { name: "#note" } }],
  });
  assert.equal(n.likeCount, 7);
  assert.deepEqual(n.hashtags, ["AI", "note"]);
  assert.equal(n.isPaid, false);
});

test("analyzeNotes summarizes likes, paid ratio, title features and JST timing", () => {
  const notes = [
    { key: "n1", name: "【保存版】10のコツ", like_count: 100, price: 1000, publish_at: "2026-11-02T12:00:00+09:00", user: { urlname: "a" } },
    { key: "n2", name: "なぜ？", like_count: 10, price: 0, publish_at: "2026-11-02T21:00:00+09:00", user: { urlname: "a" } },
    { key: "n3", name: "ふつうのタイトル", like_count: 30, price: 0, publish_at: "2026-11-03T00:30:00+09:00", user: { urlname: "b" } },
  ].map(normalizeNote);
  const a = analyzeNotes(notes, { top: 2 });

  assert.equal(a.sampleSize, 3);
  assert.equal(a.likes.median, 30);
  assert.equal(a.paid.count, 1);
  assert.equal(a.paid.ratio, 0.33);

  const brackets = a.titleFeatures.find((f) => f.feature === "brackets")!;
  assert.equal(brackets.withCount, 1);
  assert.equal(brackets.medianLikesWith, 100);
  assert.equal(a.titleFeatures.find((f) => f.feature === "question")!.withCount, 1);

  // 2026-11-02 is a Monday in JST; 00:30 JST on 11-03 must count as Tuesday hour 0.
  assert.equal(a.publishTime.byWeekday.find((d) => d.weekday === "Mon")!.count, 2);
  assert.equal(a.publishTime.byWeekday.find((d) => d.weekday === "Tue")!.count, 1);
  assert.deepEqual(a.publishTime.byHour.map((h) => h.hour), [0, 12, 21]);

  assert.deepEqual(a.topAuthors[0], { urlname: "a", nickname: null, count: 2, totalLikes: 110 });
  assert.equal(a.topNotes.length, 2);
  assert.equal(a.topNotes[0].likeCount, 100);
});

test("normalizeNote reads hashtags from hashtag_notes (v3 note detail)", () => {
  const n = normalizeNote({
    key: "nabcdef",
    name: "T",
    hashtags: null,
    hashtag_notes: [{ hashtag: { name: "#note" } }, { hashtag: { name: "#API" } }],
    user: { urlname: "u" },
  });
  assert.deepEqual(n.hashtags, ["note", "API"]);
});

test("excerpt prefers description, falls back to body, strips HTML and caps length", () => {
  assert.equal(normalizeNote({ key: "nabcdef", name: "T", description: "desc", body: "body" }).excerpt, "desc");
  assert.equal(normalizeNote({ key: "nabcdef", name: "T", body: "<p>a<br>b</p>" }).excerpt, "a b");
  assert.equal(normalizeNote({ key: "nabcdef", name: "T", body: "" }).excerpt, null);
  const long = normalizeNote({ key: "nabcdef", name: "T", body: "あ".repeat(300) }).excerpt!;
  assert.equal([...long].length, 201);
  assert.ok(long.endsWith("…"));
});

test("normalizeNotes drops unreadable rows and reports them", () => {
  const r = normalizeNotes([{ key: "nabcdef", name: "ok" }, { name: "no key" }, { key: "nzzzzzz" }, null], 40);
  assert.equal(r.items.length, 1);
  assert.deepEqual(
    r.skipped.map((s) => s.index),
    [41, 42, 43],
  );
  assert.deepEqual(normalizeNotes({ not: "an array" }).skipped, [{ index: 0, reason: "list is not an array" }]);
  assert.deepEqual(normalizeNotes(undefined), { items: [], skipped: [] });
});
