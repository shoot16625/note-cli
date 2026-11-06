import { randomUUID } from "node:crypto";
import { Marked, type Tokens } from "marked";

export interface ParsedArticle {
  title: string | undefined;
  /** Markdown body without frontmatter / leading H1 title. */
  markdown: string;
  frontmatter: Record<string, string>;
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
 * - things note can't represent (images, tables) are degraded with a warning
 */
export function markdownToNoteHtml(markdown: string): ConvertResult {
  const warnings: string[] = [];
  const marked = new Marked({ gfm: true, breaks: true });

  marked.use({
    renderer: {
      heading(this: any, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth <= 2) return `<h2>${inner}</h2>\n`;
        if (token.depth === 3) return `<h3>${inner}</h3>\n`;
        return `<p><strong>${inner}</strong></p>\n`;
      },
      image(token: Tokens.Image) {
        warnings.push(
          `Image "${token.href}" was not uploaded (image upload is not supported yet); replaced with a link. Add it in the note editor.`,
        );
        const label = escapeHtml(token.text || token.href);
        return `<a href="${escapeAttr(token.href)}">${label}</a>`;
      },
      table(this: any, token: Tokens.Table) {
        warnings.push("Tables are not supported by note.com; rendered as a code block.");
        const rows = [token.header, ...token.rows].map((row) =>
          row.map((cell: Tokens.TableCell) => cell.text).join(" | "),
        );
        return `<pre><code>${escapeHtml(rows.join("\n"))}</code></pre>\n`;
      },
      html(token: Tokens.HTML | Tokens.Tag) {
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

const BLOCK_TAGS = new Set(["p", "h2", "h3", "ul", "ol", "li", "blockquote", "pre", "figure", "hr"]);

function addBlockIds(html: string): string {
  return html.replace(/<([a-z0-9]+)(\s[^>]*)?(\/?)>/gi, (match, tag: string, attrs = "", selfClose) => {
    if (!BLOCK_TAGS.has(tag.toLowerCase()) || /\sname=/.test(attrs)) return match;
    const id = randomUUID();
    return `<${tag}${attrs} name="${id}" id="${id}"${selfClose}>`;
  });
}

function stripDangerous(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed|form|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/href="javascript:[^"]*"/gi, 'href="#"');
}

export function visibleTextLength(html: string): number {
  const text = html
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|amp|quot|#0?39|nbsp);/g, "x");
  return [...text].length;
}

/** Rough HTML -> plain text, used for reading drafts/articles back. */
export function htmlToText(html: string): string {
  return html
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
