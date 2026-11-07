import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  eyecatchRatioWarning,
  imageSize,
  isLocalImageRef,
  isStockPhotoRef,
  parseStockPhotoRef,
  readImage,
  resolveImagePath,
  sniffImageType,
  stockPhotoCropUrl,
  stockPhotoRef,
} from "../src/images.ts";

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  // SOI, an APP0 segment to skip, then SOF0 with height/width.
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0,
  ]);
}

test("sniffImageType and imageSize read PNG, JPEG and GIF headers", () => {
  assert.equal(sniffImageType(png(1, 1)), "image/png");
  assert.deepEqual(imageSize(png(1280, 670)), { width: 1280, height: 670 });
  assert.equal(sniffImageType(jpeg(1, 1)), "image/jpeg");
  assert.deepEqual(imageSize(jpeg(640, 335)), { width: 640, height: 335 });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
  assert.deepEqual(imageSize(gif), { width: 800, height: 600 });
  assert.equal(sniffImageType(new TextEncoder().encode("<svg></svg>")), null);
});

test("eyecatchRatioWarning flags images that are not 1280:670", () => {
  const file = (bytes: Uint8Array<ArrayBuffer>) => ({ path: "/x", filename: "x.png", mimeType: "image/png", bytes });
  assert.equal(eyecatchRatioWarning(file(png(1280, 670))), null);
  assert.equal(eyecatchRatioWarning(file(png(2560, 1340))), null);
  assert.match(eyecatchRatioWarning(file(png(320, 200)))!, /320x200/);
});

test("local image refs resolve against the Markdown file's directory", () => {
  assert.equal(isLocalImageRef("img/a.png"), true);
  assert.equal(isLocalImageRef("/abs/a.png"), true);
  assert.equal(isLocalImageRef("file:///abs/a.png"), true);
  assert.equal(isLocalImageRef("https://x.com/a.png"), false);
  assert.equal(isLocalImageRef("//cdn/a.png"), false);
  assert.equal(isLocalImageRef("data:image/png;base64,xx"), false);
  assert.equal(resolveImagePath("img/my%20pic.png", "/docs"), "/docs/img/my pic.png");
  assert.equal(resolveImagePath("/abs/a.png", "/docs"), "/abs/a.png");
});

test("readImage rejects missing files and non-images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "note-cli-img-"));
  await writeFile(join(dir, "fake.png"), "not an image");
  await assert.rejects(readImage(join(dir, "fake.png")), /Unsupported image type/);
  await assert.rejects(readImage(join(dir, "missing.png")), /Cannot read image/);
  await writeFile(join(dir, "ok.png"), png(10, 10));
  const img = await readImage(join(dir, "ok.png"));
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.filename, "ok.png");
});

test("gallery photo refs round-trip and only point at note's image CDN", () => {
  const url = "https://assets.st-note.com/production/uploads/images/8286527/b953.jpg";
  const ref = stockPhotoRef(24215, url);
  assert.equal(ref, `stock:24215:${url}`);
  assert.ok(isStockPhotoRef(` ${ref}`));
  assert.ok(!isStockPhotoRef("cover.png"));
  assert.deepEqual(parseStockPhotoRef(ref), { stockPhotoImageId: 24215, url });
  assert.deepEqual(parseStockPhotoRef(`${ref}?width=500`), { stockPhotoImageId: 24215, url });
  for (const bad of ["stock:24215", "stock:x:" + url, "stock:1:https://evil.example/a.jpg", "stock:1:http://assets.st-note.com/a.jpg"]) {
    assert.throws(() => parseStockPhotoRef(bad), /photo search/, bad);
  }
  assert.equal(stockPhotoCropUrl(url), `${url}?width=1280&height=670&fit=crop&format=jpeg&quality=95`);
});
