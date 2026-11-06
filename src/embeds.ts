import { basename } from "node:path";
import { CliError, type NoteClient } from "./client.ts";

/** A block that note renders from its own data: an embed card/player or a file attachment. */
export interface Embed {
  /** note's `embedded-service` name, e.g. youtube, twitter, note, external-article, attachment. */
  service: string;
  /** `embedded-content-key` (emb...). */
  key: string;
  /** The URL the embed points to (null for attachments). */
  url: string | null;
  /** For note article cards: the article key. */
  identifier: string | null;
  /** Inner HTML note stores inside the figure (attachments only). */
  html: string | null;
}

/**
 * URL patterns note's editor uses to pick an embed service (copied from editor.note.com).
 * URLs matching none of them still embed, as a link card (`external-article`) or an oEmbed player.
 */
const SERVICES: Array<[string, RegExp]> = Object.entries({
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
  "apple-podcast": String.raw`^https://podcasts\.apple\.com\/[a-z]{2}\/podcast\/(.+\/)?id[0-9]+`,
}).map(([name, pattern]) => [name, new RegExp(pattern)]);

const NOTE_ARTICLE = /^https:\/\/note\.com\/[A-Za-z0-9_-]+\/n\/(n[0-9a-f]{8,})\/?(?:[?#].*)?$/;

/** The service note's editor would pick from the URL alone; null = decided by the server (card or oEmbed). */
export function embedService(url: string): string | null {
  if (NOTE_ARTICLE.test(url)) return "note";
  return SERVICES.find(([, re]) => re.test(url))?.[0] ?? null;
}

/** Create an embed for `url` on the draft `noteKey`, exactly as pasting the URL into the editor does. */
export async function createEmbed(client: NoteClient, noteKey: string, url: string): Promise<Embed> {
  const article = url.match(NOTE_ARTICLE);
  if (article) {
    const form = new FormData();
    form.append("url", url);
    form.append("height", "211");
    form.append("embeddable_type", "Note");
    form.append("embeddable_key", noteKey);
    const res = await client.request("/v1/embed", { method: "POST", auth: "required", editor: true, form });
    const key = res?.data?.embedded_content?.key;
    if (typeof key !== "string") throw new CliError("API_ERROR", `note did not return an embed for ${url}.`, { detail: res });
    return { service: "note", key, url, identifier: article[1], html: null };
  }

  let service = embedService(url);
  if (!service) {
    // The editor asks the server about URLs it does not recognise (oEmbed providers, job postings).
    const check = await client.request("/v2/embed_by_external_api/check_type", { auth: "required", editor: true, query: { url } });
    const type = check?.data?.type;
    service = type === "Oembed" ? "oembed" : type === "JobPosting" ? "hr" : typeof type === "string" && type ? type : "external-article";
  }
  const res = await client.request("/v2/embed_by_external_api", {
    auth: "required",
    editor: true,
    query: { url, service, embeddable_key: noteKey, embeddable_type: "Note" },
  });
  const key = res?.data?.key;
  if (typeof key !== "string") throw new CliError("API_ERROR", `note did not return an embed for ${url}.`, { detail: res });
  return { service: service!, key, url, identifier: null, html: null };
}

/** Upload a file as a download attachment on the draft `noteKey`. */
export async function uploadAttachment(
  client: NoteClient,
  noteKey: string,
  file: { path: string; bytes: Uint8Array<ArrayBuffer>; mimeType: string },
): Promise<Embed> {
  const name = basename(file.path);
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mimeType }), name);
  form.append("file_name", name);
  form.append("note_key", noteKey);
  const res = await client.request("/v2/attachments/upload", { method: "POST", auth: "required", editor: true, form });
  const d = res?.data;
  if (d?.error) throw new CliError("API_ERROR", `Attachment ${name} was rejected: ${d.error?.message ?? JSON.stringify(d.error)}`, { detail: res });
  if (typeof d?.embedded_content_key !== "string" || typeof d?.html_for_embed !== "string") {
    throw new CliError("API_ERROR", `note did not accept the attachment ${name}.`, { detail: res });
  }
  return { service: "attachment", key: d.embedded_content_key, url: null, identifier: d.attachment_key ?? null, html: d.html_for_embed };
}

const MIME: Record<string, string> = {
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
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function attachmentMime(path: string): string {
  return MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
