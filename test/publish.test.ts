import assert from "node:assert/strict";
import { test } from "bun:test";
import { markdownToNoteHtml } from "../src/markdown.ts";
import { buildPublishPayload, imageKey, topLevelBlocks, type PublishSettings } from "../src/publish.ts";

const base: PublishSettings = { hashtags: [], price: 0, magazineKeys: [], notify: true, toc: false, disableComments: false, refund: false };

test("topLevelBlocks splits only at depth 0 and handles void tags", () => {
  const html = '<p name="a">x<br>y</p><figure name="b"><img src="s"><figcaption>c</figcaption></figure><ul name="c"><li>1</li></ul><paywall-line></paywall-line>';
  assert.deepEqual(topLevelBlocks(html).map((b) => b.slice(0, 8)), ['<p name=', "<figure ", "<ul name", "<paywall"]);
});

test("imageKey takes the 32-hex id from an uploaded image URL", () => {
  assert.equal(imageKey("https://assets.st-note.com/img/1700000000-0123456789abcdef0123456789abcdef.png"), "0123456789abcdef0123456789abcdef");
  assert.equal(imageKey("https://assets.st-note.com/img/abc.png"), "abc");
  assert.equal(imageKey("pic.png"), null);
});

test("the <!-- paywall --> marker splits a paid article into free and paid parts", () => {
  const { html } = markdownToNoteHtml("free part\n\n<!-- paywall -->\n\npaid part");
  assert.match(html, /<paywall-line><\/paywall-line>/);
  const p = buildPublishPayload({ name: "T", body: html }, { ...base, price: 300, hashtags: ["#AI", "note"], refund: true });
  assert.match(p.free_body, /free part/);
  assert.doesNotMatch(p.free_body, /paid part|paywall/);
  assert.match(p.pay_body, /paid part/);
  assert.equal(p.separator, p.free_body.match(/name="([^"]+)"/)![1]);
  assert.deepEqual(p.hashtags, ["#AI", "#note"]);
  assert.equal(p.is_refund, true);
  assert.equal(p.status, "published");
  assert.equal(p.body_length, "free partpaid part".length);
});

test("a free article ignores the paywall and keeps the whole body free", () => {
  const { html } = markdownToNoteHtml("a\n\n<!-- paywall -->\n\nb");
  const p = buildPublishPayload({ name: "T", body: html }, base);
  assert.match(p.free_body, /a<\/p>.*b<\/p>/);
  assert.equal(p.pay_body, "");
  assert.equal(p.separator, null);
});

test("a paid article without a paywall is rejected", () => {
  const { html } = markdownToNoteHtml("only text");
  assert.throws(() => buildPublishPayload({ name: "T", body: html }, { ...base, price: 100 }), /paywall/);
});

test("a scheduled publish sends status reserved and publish_at", () => {
  const p = buildPublishPayload({ name: "T", body: "<p>x</p>", slug: "slug-1" }, { ...base, publishAt: "2026-12-01T00:00:00.000Z" });
  assert.equal(p.status, "reserved");
  assert.equal(p.publish_at, "2026-12-01T00:00:00.000Z");
  assert.equal(p.slug, "slug-1");
});

test("embedded figures with nested markup stay single blocks in the free/paid split", () => {
  const att = '<figure name="f" id="f" embedded-service="attachment" embedded-content-key="e"><div class="a"><div><a href="x"><i class="icon"></i><strong>a.pdf</strong></a></div></div></figure>';
  const html = `<p name="p1" id="p1">free</p>${att}<paywall-line></paywall-line><p name="p2" id="p2">paid</p>`;
  assert.deepEqual(topLevelBlocks(html).length, 4);
  const p = buildPublishPayload({ name: "T", body: html, key: "nabc" }, { ...base, price: 100 });
  assert.equal(p.free_body, `<p name="p1" id="p1">free</p>${att}`);
  assert.equal(p.separator, "f");
  assert.equal(p.body_length, 8);
  assert.equal(p.slug, "slug-nabc");
});
