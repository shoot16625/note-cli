import { CliError } from "./client.ts";

const NOTE_KEY = /^n[0-9a-z]{6,32}$/;
const URLNAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Accept a note key (`n...`) or any note.com / editor URL that contains one. */
export function noteKey(input: string): string {
  const s = input.trim();
  const fromUrl = s.match(/(?:^|\/)(n[0-9a-z]{6,32})(?:[/?#]|$)/)?.[1];
  const key = fromUrl ?? s;
  if (!NOTE_KEY.test(key)) throw new CliError("USAGE", `Not a note key or note URL: "${input}". Expected something like n1a2b3c4d5e6.`);
  return key;
}

/** Accept a numeric note id, a note key, or a note URL. */
export function noteIdOrKey(input: string): { id: number } | { key: string } {
  const s = input.trim();
  if (/^\d{1,12}$/.test(s)) return { id: Number(s) };
  return { key: noteKey(s) };
}

/** A creator's urlname, also accepting https://note.com/<urlname> URLs and a leading @. */
export function urlname(input: string): string {
  const s = input.trim().replace(/^@/, "");
  const fromUrl = s.match(/^https?:\/\/note\.com\/([^/?#]+)/)?.[1];
  const name = fromUrl ?? s;
  if (!URLNAME.test(name)) throw new CliError("USAGE", `Not a note urlname: "${input}". Use letters, digits, _ or -.`);
  return name;
}

/** A hashtag name without the leading #. Rejects anything that could change the request path. */
export function hashtag(input: string): string {
  const name = input.trim().replace(/^#/, "");
  // note silently drops *every* hashtag of an article when one of them contains a dot or a space.
  if (!name || name.length > 100 || /[\s/\\?#%.]/.test(name)) {
    throw new CliError("USAGE", `Not a valid hashtag: "${input}" (no spaces, dots or / ? # %).`);
  }
  return name;
}

const MAGAZINE_KEY = /^m[0-9a-z]{6,32}$/;

/** A magazine key (`m...`) or a magazine URL (https://note.com/<urlname>/m/<key>). */
export function magazineKey(input: string): string {
  const s = input.trim();
  const fromUrl = s.match(/\/m\/(m[0-9a-z]{6,32})(?:[/?#]|$)/)?.[1];
  const key = fromUrl ?? s;
  if (!MAGAZINE_KEY.test(key)) {
    throw new CliError("USAGE", `Not a magazine key or URL: "${input}". Expected something like m97e554a23b24.`);
  }
  return key;
}

/** A category slug as listed by `categories` (e.g. tech, column), or `featured`. */
export function categorySlug(input: string): string {
  const s = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(s)) throw new CliError("USAGE", `Not a category slug: "${input}". Run \`note-cli categories\`.`);
  return s;
}

/** An opaque key from note (comment keys and the like): letters, digits, _ and - only. */
export function token(input: string, what: string): string {
  const s = input.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new CliError("USAGE", `Not a valid ${what}: "${input}".`);
  return s;
}
