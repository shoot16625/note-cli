import assert from "node:assert/strict";
import { test } from "bun:test";
import { blockLinks, htmlToText, imageRefs, markdownToNoteHtml, obsidianToMarkdown, parseArticle, safeHref, visibleTextLength } from "../src/markdown.ts";

test("parseArticle prefers frontmatter title and strips frontmatter", () => {
  const a = parseArticle("---\ntitle: \"FM Title\"\ntags: x\n---\n# H1 Title\n\nbody");
  assert.equal(a.title, "FM Title");
  assert.equal(a.frontmatter.tags, "x");
  assert.match(a.markdown, /^# H1 Title/);
});

test("parseArticle falls back to the leading H1 and removes it from the body", () => {
  const a = parseArticle("﻿# My Post\r\n\r\nHello");
  assert.equal(a.title, "My Post");
  assert.equal(a.markdown, "Hello");
});

test("parseArticle returns undefined title when there is none", () => {
  assert.equal(parseArticle("just text").title, undefined);
});

test("headings map to note's two levels", () => {
  const { html } = markdownToNoteHtml("# a\n\n## b\n\n### c\n\n#### d");
  assert.match(html, /<h2 [^>]*>a<\/h2>/);
  assert.match(html, /<h2 [^>]*>b<\/h2>/);
  assert.match(html, /<h3 [^>]*>c<\/h3>/);
  assert.match(html, /<p [^>]*><strong>d<\/strong><\/p>/);
});

test("block elements get matching name/id UUIDs, inline ones do not", () => {
  const { html } = markdownToNoteHtml("para **bold** [link](https://x.com)\n\n- item");
  const ids = [...html.matchAll(/name="([^"]+)" id="([^"]+)"/g)];
  assert.equal(ids.length, 3); // p, ul, li
  for (const m of ids) assert.equal(m[1], m[2]);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/x.com">link<\/a>/);
});

test("single newlines become <br> and code block newlines are preserved", () => {
  const { html } = markdownToNoteHtml("line1\nline2\n\n```\na\nb\n```");
  assert.match(html, /line1<br>line2/);
  assert.match(html, /<code>a\nb<\/code>/);
  assert.doesNotMatch(html, />\n</);
});

test("images and tables degrade with warnings; raw HTML is escaped", () => {
  const r = markdownToNoteHtml("![alt](https://x.com/pic.png)\n\n![local](pic.png)\n\n|a|b|\n|-|-|\n|1|2|\n\n<script>alert(1)</script>");
  assert.equal(r.warnings.length, 4);
  assert.match(r.html, /<a href="https:\/\/x.com\/pic.png">alt<\/a>/);
  assert.match(r.html, />local</);
  assert.match(r.html, /<code>a \| b\n1 \| 2<\/code>/);
  assert.doesNotMatch(r.html, /<script>/);
});

test("empty markdown yields an empty paragraph", () => {
  assert.equal(markdownToNoteHtml("").html, "<p></p>");
});

test("bodyLength counts visible characters only", () => {
  assert.equal(visibleTextLength('<p name="x">あい<br>う</p><p>&amp;</p>'), 4);
  assert.equal(markdownToNoteHtml("こんにちは").bodyLength, 5);
});

test("htmlToText renders a readable outline", () => {
  const text = htmlToText("<h2>T</h2><p>a<br>b &amp; c</p><ul><li>x</li></ul>");
  assert.equal(text, "## T\na\nb & c\n- x");
});

test("safeHref allows only absolute http(s) and mailto URLs", () => {
  assert.equal(safeHref("https://note.com/x"), "https://note.com/x");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,x", "vbscript:x", "/relative", "pic.png"]) {
    assert.equal(safeHref(bad), null, bad);
  }
});

test("unsafe links keep their text but lose the href", () => {
  const r = markdownToNoteHtml("[click](JavaScript:alert(1)) and [data](data:text/html,hi) and [ok](https://x.com)");
  assert.doesNotMatch(r.html, /javascript|data:/i);
  assert.match(r.html, /click and data and <a href="https:\/\/x.com">ok<\/a>/);
  assert.equal(r.warnings.length, 2);
});

test("uploaded images become figure blocks lifted out of their paragraph", () => {
  const images = new Map([["a.png", "https://assets.st-note.com/img/1.png"]]);
  const r = markdownToNoteHtml('before ![cat & dog](a.png "Cap") after\n\n![x](https://x.com/r.png)', { images });
  const blocks = r.html.match(/<(p|figure) [^>]*>/g)!.map((t) => t.slice(1, t.indexOf(" ")));
  assert.deepEqual(blocks, ["p", "figure", "p", "p"]);
  assert.match(
    r.html,
    /<figure name="[^"]+" id="[^"]+"><img src="https:\/\/assets.st-note.com\/img\/1.png" alt="cat &amp; dog" width="620" height="auto"><figcaption>Cap<\/figcaption><\/figure>/,
  );
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /remote URL/);
});

test("imageRefs lists each image src once, including nested ones", () => {
  assert.deepEqual(imageRefs("![a](x.png)\n\n- ![b](y.png)\n\n> ![c](x.png)"), ["x.png", "y.png"]);
});

test("htmlToText keeps images as Markdown", () => {
  const t = htmlToText('<p>Hi</p><figure><img src="https://x/1.png" alt="a" width="620"><figcaption>Cap</figcaption></figure>');
  assert.equal(t, "Hi\n\n![a](https://x/1.png)\nCap");
});

test("blockLinks finds bare URLs and local-file links that stand alone", () => {
  const md = [
    "https://youtu.be/abc",
    "<https://x.com/u/status/1>",
    "[titled](https://example.com)",
    "text https://inline.example.com",
    "[file](./a.pdf)",
    "[anchor](#top)",
    "- https://in-a-list.example.com",
    "```\nhttps://in-code.example.com\n```",
  ].join("\n\n");
  assert.deepEqual(blockLinks(md), { urls: ["https://youtu.be/abc", "https://x.com/u/status/1"], files: ["./a.pdf"] });
});

test("embeds become figures and their widget text is not counted", () => {
  const embeds = new Map([
    ["https://youtu.be/abc", { service: "youtube", key: "emb1", url: "https://youtu.be/abc", identifier: null, html: null }],
    ["a.pdf", { service: "attachment", key: "emb2", url: null, identifier: "x", html: '<div><strong class="file-widget__filename">a.pdf</strong></div>' }],
  ]);
  const r = markdownToNoteHtml("hi\n\nhttps://youtu.be/abc\n\n[doc](a.pdf)", { embeds });
  assert.match(r.html, /<figure data-src="https:\/\/youtu.be\/abc" data-identifier="null" embedded-service="youtube" embedded-content-key="emb1" name="[^"]+" id="[^"]+"><\/figure>/);
  assert.match(r.html, /<figure embedded-service="attachment" embedded-content-key="emb2" name="[^"]+" id="[^"]+"><div>/);
  assert.equal(r.bodyLength, 2);
  assert.equal(htmlToText(r.html), "hi\n\nhttps://youtu.be/abc\n\n[attachment: a.pdf]");
});

test("obsidianToMarkdown converts embeds, wikilinks and highlights outside code", () => {
  const md = "![[img one.png|alt]] ![[pic.png|300]] [[Page]] [[Page|label]] ==mark== `==code==`\n```\n==fenced== [[x]]\n```";
  assert.equal(
    obsidianToMarkdown(md),
    "![alt](<img one.png>) ![](<pic.png>) Page label **mark** `==code==`\n```\n==fenced== [[x]]\n```",
  );
  assert.deepEqual(imageRefs(parseArticle("# T\n\n![[a b.png]]").markdown), ["a b.png"]);
});
