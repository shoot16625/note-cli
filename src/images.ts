import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { CliError } from "./client.ts";

export interface ImageFile {
  path: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** note's editor rejects larger images. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Detect the image type from its first bytes, so a mislabeled extension can't slip through. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" &&
    String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** A Markdown image reference that points at a local file (not a URL). */
export function isLocalImageRef(src: string): boolean {
  const s = src.trim();
  if (!s || s.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(s) || /^file:\/\//i.test(s);
}

/** Resolve a Markdown image src against the Markdown file's directory. */
export function resolveImagePath(src: string, baseDir: string): string {
  let s = src.trim();
  if (/^file:\/\//i.test(s)) s = new URL(s).pathname;
  try {
    s = decodeURI(s);
  } catch {
    // keep as written
  }
  return isAbsolute(s) ? s : resolve(baseDir, s);
}

/** Read and validate a local image (type and size). */
export async function readImage(path: string): Promise<ImageFile> {
  const info = await stat(path).catch((e) => {
    throw new CliError("INVALID_INPUT", `Cannot read image ${path}: ${(e as Error).message}`);
  });
  if (!info.isFile()) throw new CliError("INVALID_INPUT", `Not a file: ${path}`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new CliError("INVALID_INPUT", `Image ${path} is ${(info.size / 1024 / 1024).toFixed(1)} MB; note accepts up to 10 MB.`);
  }
  const bytes = new Uint8Array(await readFile(path));
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new CliError("INVALID_INPUT", `Unsupported image type: ${path} (use PNG, JPEG, GIF or WebP).`);
  return { path, filename: basename(path), mimeType, bytes };
}

/** note's eyecatch (cover) must have this aspect ratio, e.g. 1280x670. */
export const EYECATCH_RATIO = 1280 / 670;

/** Read width/height from a PNG, GIF, JPEG or WebP header; null when it can't be parsed. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === "image/png") return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (type === "image/gif") return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (type === "image/webp") {
      const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (chunk === "VP8X") {
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width: w, height: h };
      }
      if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const b = dv.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        const len = dv.getUint16(i + 2);
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch {
    // truncated header
  }
  return null;
}

/** A warning when an eyecatch is clearly not 1280:670 (note rejects it), else null. */
export function eyecatchRatioWarning(image: ImageFile): string | null {
  const size = imageSize(image.bytes);
  if (!size || !size.height) return null;
  const ratio = size.width / size.height;
  if (Math.abs(ratio - EYECATCH_RATIO) / EYECATCH_RATIO <= 0.01) return null;
  return `Eyecatch ${image.filename} is ${size.width}x${size.height}; note requires a 1280:670 aspect ratio (e.g. 1280x670) and will likely reject it.`;
}
