import { randomUUID } from "node:crypto";
import { Marked, type Tokens } from "marked";

export interface ParsedArticle {
  title: string | undefined;
  /** Markdown body without frontmatter / leading H1 title. */
  markdown: string;
  frontmatter: Record<string, string>;
}

export interface ConvertOptions {
  /** Markdown image src -> uploaded image URL. Images found here become `<figure>` blocks. */
  images?: ReadonlyMap<string, string>;
}

export interface ConvertResult {
  html: string;
  /** Visible text length (tags stripped) — note.com expects this as body_length. */
  bodyLength: number;
  warnings: string[];
}

/** Split simple `key: value` YAML frontmatter and pick the title (frontmatter > first H1). */
export function parseArticle(source: string): ParsedArticle {
  let markdown = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const frontmatter: Record<string, string> = {};

  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) frontmatter[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
    markdown = markdown.slice(fm[0].length);
  }

  let title: string | undefined = frontmatter.title || undefined;
  if (!title) {
    const h1 = markdown.match(/^\s*#\s+(.+?)\s*#*\s*(\n|$)/);
    if (h1) {
      title = h1[1].trim();
      markdown = markdown.slice(h1[0].length);
    }
  }
  return { title, markdown: markdown.replace(/^\n+/, ""), frontmatter };
}

/**
 * Convert Markdown to the HTML dialect the note.com editor stores.
 * - note only has two heading levels: #/## -> h2, ### -> h3, deeper -> bold paragraph
 * - block elements get `name`/`id` UUID attributes like the editor produces
 * - images listed in `opts.images` become `<figure>` blocks; other images and tables are degraded with a warning
 */
export function markdownToNoteHtml(markdown: string, opts: ConvertOptions = {}): ConvertResult {
  const warnings: string[] = [];
  const images = opts.images ?? new Map<string, string>();
  const marked = new Marked({ gfm: true, breaks: true });
  const uploaded = (t: Tokens.Generic) => t.type === "image" && images.has((t as Tokens.Image).href);

  marked.use({
    renderer: {
      paragraph(this: any, token: Tokens.Paragraph) {
        // note has no inline images: lift uploaded images out of the paragraph into their own <figure> blocks.
        if (!token.tokens.some(uploaded)) return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
        let out = "";
        let run: Tokens.Generic[] = [];
        const flush = () => {
          const inner = this.parser.parseInline(run).replace(/^(\s|<br>)+|(\s|<br>)+$/g, "");
          if (inner) out += `<p>${inner}</p>\n`;
          run = [];
        };
        for (const t of token.tokens) {
          if (uploaded(t)) {
            flush();
            out += figure(images.get((t as Tokens.Image).href)!, t as Tokens.Image);
          } else {
            run.push(t);
          }
        }
        flush();
        return out;
      },
      heading(this: any, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth <= 2) return `<h2>${inner}</h2>\n`;
        if (token.depth === 3) return `<h3>${inner}</h3>\n`;
        return `<p><strong>${inner}</strong></p>\n`;
      },
      link(this: any, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const href = safeHref(token.href);
        if (!href) {
          warnings.push(`Link "${token.href}" was dropped (only http, https and mailto links are allowed).`);
          return inner;
        }
        return `<a href="${escapeAttr(href)}">${inner}</a>`;
      },
      image(token: Tokens.Image) {
        // Reached only for images that were not uploaded (uploaded ones are handled in paragraph()).
        if (images.has(token.href)) {
          warnings.push(`Image "${token.href}" is inside a list item; note may not show it there. Put images on their own line.`);
          return figure(images.get(token.href)!, token);
        }
        const label = escapeHtml(token.text || token.href);
        const href = safeHref(token.href);
        warnings.push(
          href
            ? `Image "${token.href}" is a remote URL and was not uploaded; replaced with a link. Save it locally and reference the file to embed it.`
            : `Image "${token.href}" was not uploaded; replaced with its alt text.`,
        );
        return href ? `<a href="${escapeAttr(href)}">${label}</a>` : label;
      },
      table(this: any, token: Tokens.Table) {
        warnings.push("Tables are not supported by note.com; rendered as a code block.");
        const rows = [token.header, ...token.rows].map((row) =>
          row.map((cell: Tokens.TableCell) => cell.text).join(" | "),
        );
        return `<pre><code>${escapeHtml(rows.join("\n"))}</code></pre>\n`;
      },
      html(token: Tokens.HTML | Tokens.Tag) {
        // `<!-- paywall -->` marks where the paid part of an article starts.
        if (PAYWALL_MARKER.test(token.raw.trim())) return `${PAYWALL_LINE}\n`;
        warnings.push("Raw HTML in Markdown was escaped.");
        return escapeHtml(token.raw);
      },
    },
  });

  let html = marked.parse(markdown, { async: false }) as string;
  html = stripDangerous(html);
  // Drop the formatting newlines marked emits between tags, but keep the ones inside <pre>.
  html = addBlockIds(html)
    .replace(/\n+<\/code><\/pre>/g, "</code></pre>")
    .replace(/>\n+</g, "><")
    .trim();
  if (!html) html = "<p></p>";
  return { html, bodyLength: visibleTextLength(html), warnings: [...new Set(warnings)] };
}

const PAYWALL_MARKER = /^<!--\s*paywall\s*-->$/i;
/** How note's editor stores the paid-part divider inside a draft body. */
export const PAYWALL_LINE = "<paywall-line></paywall-line>";

/** The block note's editor produces for an image; the optional Markdown title becomes the caption. */
function figure(src: string, token: Tokens.Image): string {
  const caption = token.title ? `<figcaption>${escapeHtml(token.title)}</figcaption>` : "";
  return `<figure><img src="${escapeAttr(src)}" alt="${escapeAttr(token.text ?? "")}" width="620" height="auto">${caption}</figure>\n`;
}

/** Every image src in the Markdown, in order, without duplicates. */
export function imageRefs(markdown: string): string[] {
  const refs = new Set<string>();
  const m = new Marked({ gfm: true, breaks: true });
  m.walkTokens(m.lexer(markdown), (t) => {
    if (t.type === "image") refs.add((t as Tokens.Image).href);
  });
  return [...refs];
}

const BLOCK_TAGS = new Set(["p", "h2", "h3", "ul", "ol", "li", "blockquote", "pre", "figure", "hr"]);

function addBlockIds(html: string): string {
  return html.replace(/<([a-z0-9]+)(\s[^>]*)?(\/?)>/gi, (match, tag: string, attrs = "", selfClose) => {
    if (!BLOCK_TAGS.has(tag.toLowerCase()) || /\sname=/.test(attrs)) return match;
    const id = randomUUID();
    return `<${tag}${attrs} name="${id}" id="${id}"${selfClose}>`;
  });
}

/** Allow only absolute http(s) and mailto URLs; everything else (javascript:, data:, relative paths, ...) is dropped. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

function stripDangerous(html: string): string {
  // Defense in depth: renderers above already escape raw HTML and filter link schemes.
  return html
    .replace(/<(script|iframe|object|embed|form|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "");
}

export function visibleTextLength(html: string): number {
  const text = html
    .replace(/<paywall-line[^>]*>\s*<\/paywall-line>/gi, "")
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|amp|quot|#0?39|nbsp);/g, "x");
  return [...text].length;
}

/** Rough HTML -> plain text, used for reading drafts/articles back. */
export function htmlToText(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const attr = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1] ?? "";
      return `\n![${attr("alt")}](${attr("src")})\n`;
    })
    .replace(/<figcaption[^>]*>/gi, "")
    .replace(/<paywall-line[^>]*>\s*<\/paywall-line>/gi, "\n----- paywall -----\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|blockquote|pre|figure)>/gi, "\n")
    .replace(/<h2[^>]*>/gi, "## ")
    .replace(/<h3[^>]*>/gi, "### ")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
