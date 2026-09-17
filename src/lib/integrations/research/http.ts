/**
 * Shared HTTP + text-cleanup helpers for research source adapters.
 */
import { readEnv } from "@/lib/env";

/** Error raised by a research source adapter; carries the source id and, when known, an HTTP status. */
export class ResearchSourceError extends Error {
  readonly sourceId: string;
  readonly status?: number;

  constructor(message: string, sourceId: string, status?: number) {
    super(message);
    this.name = "ResearchSourceError";
    this.sourceId = sourceId;
    this.status = status;
  }
}

/** Polite User-Agent for public APIs, including a contact email when configured. */
export function userAgent(): string {
  const email = readEnv("CONTACT_EMAIL");
  return email ? `LENS-research-agent/0.1 (mailto:${email})` : "LENS-research-agent/0.1";
}

/** `fetch` with an abort-based timeout. */
export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Elements whose closing tag should leave a paragraph break behind, so text
// extracted from surrounding block elements doesn't run together.
const BLOCK_TAGS = ["p", "div", "section", "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr", "sec", "title"];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  // Common Latin-1 accented letters, as seen in author names / titles.
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  iuml: "ï",
  oacute: "ó",
  ouml: "ö",
  uacute: "ú",
  uuml: "ü",
  ntilde: "ñ",
  ccedil: "ç",
  aacute: "á",
  agrave: "à",
  auml: "ä",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

/**
 * Strip markup (HTML or XML/JATS) down to plain text: removes script/style/nav/
 * header/footer blocks and all tags, decodes entities, keeps paragraph breaks
 * for block-level elements, and collapses remaining whitespace.
 */
export function stripMarkup(xmlOrHtml: string): string {
  let text = xmlOrHtml;

  // Drop entire blocks that never contain body text.
  text = text.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Mark paragraph breaks at the close of block-level elements before tags are stripped.
  const blockClosePattern = new RegExp(`</?(?:${BLOCK_TAGS.join("|")})\\b[^>]*>`, "gi");
  text = text.replace(blockClosePattern, "\n\n");

  // Cell/separator tags become spaces; other inline tags (b, i, sup, a, span…) vanish without adding space.
  text = text.replace(/<\/?(?:td|th|dt|dd|img|hr|input|label|caption)\b[^>]*>/gi, " ");
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities.
  text = decodeEntities(text);

  // Collapse whitespace, but preserve paragraph breaks.
  text = text
    .split("\n\n")
    .map((chunk) => chunk.replace(/\s+/g, " ").trim())
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");

  return text.trim();
}
