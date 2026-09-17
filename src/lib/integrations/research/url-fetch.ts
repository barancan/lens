/**
 * Fetches an arbitrary URL as a research source, with an SSRF guard: only
 * public http(s) hosts are allowed, redirects are followed manually and
 * re-validated at each hop, and the response is capped in size and type.
 */
import { promises as dnsPromises } from "node:dns";
import type { ResearchSource, SearchQuery, SearchResult, SourceDocument } from "@/lib/research/types";
import type { SourceType } from "@/lib/types";
import { ResearchSourceError, fetchWithTimeout, stripMarkup, userAgent } from "./http";

const SOURCE_ID = "url";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB
const DEFAULT_MAX_REDIRECTS = 3;
const ACCEPTED_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface LookupResult {
  address: string;
  family: number;
}

/** Injectable DNS lookup, so tests don't hit real DNS. */
export type DnsLookupFn = (hostname: string, options: { all: true }) => Promise<LookupResult[]>;

const defaultLookup: DnsLookupFn = (hostname, options) => dnsPromises.lookup(hostname, options);

export interface FetchUrlOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  lookup?: DnsLookupFn;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // fail closed on anything we can't parse confidently
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
  if (a >= 224) return true; // 224.0.0.0/4 multicast + reserved
  return false;
}

function isPrivateIPv6(address: string): boolean {
  if (address === "::1" || address === "::" || address === "0:0:0:0:0:0:0:0" || address === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const firstGroup = address.split(":")[0] ?? "";
  if (firstGroup.length === 0) return false; // other "::..." forms: not classified as private here
  const groupNum = parseInt(firstGroup, 16);
  if (Number.isNaN(groupNum)) return false;
  if (groupNum >= 0xfc00 && groupNum <= 0xfdff) return true; // fc00::/7 unique local
  if (groupNum >= 0xfe80 && groupNum <= 0xfebf) return true; // fe80::/10 link-local
  if (groupNum >= 0xff00 && groupNum <= 0xffff) return true; // ff00::/8 multicast
  return false;
}

/** True when `ip` is a loopback, private, link-local, CGNAT, multicast or unspecified address. */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.trim().toLowerCase();

  // IPv4-mapped IPv6, e.g. "::ffff:127.0.0.1"
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isPrivateIPv4(mapped[1]);
  }

  if (address.includes(":")) {
    return isPrivateIPv6(address);
  }
  return isPrivateIPv4(address);
}

/** Validates that `url` is http(s), has no embedded credentials, and resolves only to public addresses. */
export async function assertPublicUrl(url: string, opts?: { lookup?: DnsLookupFn }): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResearchSourceError(`Invalid URL: ${url}`, SOURCE_ID);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ResearchSourceError(`Unsupported URL scheme: ${parsed.protocol}`, SOURCE_ID);
  }
  if (parsed.username || parsed.password) {
    throw new ResearchSourceError("URLs with embedded credentials are not allowed", SOURCE_ID);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "localhost.localdomain") {
    throw new ResearchSourceError("Requests to localhost are not allowed", SOURCE_ID);
  }

  const lookup = opts?.lookup ?? defaultLookup;
  let addresses: LookupResult[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new ResearchSourceError(`Could not resolve host: ${hostname}`, SOURCE_ID);
  }
  if (addresses.length === 0) {
    throw new ResearchSourceError(`Could not resolve host: ${hostname}`, SOURCE_ID);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ResearchSourceError(`Refusing to fetch private/internal address: ${address}`, SOURCE_ID);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Body reading with a size cap
// ---------------------------------------------------------------------------

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResearchSourceError(`Response body exceeds ${maxBytes} bytes`, SOURCE_ID);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResearchSourceError(`Response body exceeds ${maxBytes} bytes`, SOURCE_ID);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// ---------------------------------------------------------------------------
// HTML metadata extraction (regex-based, no DOM)
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMetaContent(html: string, key: string): string | null {
  const k = escapeRegExp(key);
  const patterns = [
    new RegExp(`<meta[^>]*(?:name|property)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${k}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function findAllMetaContents(html: string, key: string): string[] {
  const k = escapeRegExp(key);
  const pattern = new RegExp(
    `<meta[^>]*(?:name|property)=["']${k}["'][^>]*content=["']([^"']*)["']|<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${k}["']`,
    "gi",
  );
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const value = match[1] ?? match[2];
    if (value) results.push(value);
  }
  return results;
}

function clean(text: string): string {
  return stripMarkup(text).trim();
}

function normalizeDoi(raw: string): string | null {
  const match = raw.match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return match ? match[0] : null;
}

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}`;
  const yearOnly = trimmed.match(/^(\d{4})$/);
  if (yearOnly) return `${yearOnly[1]}-01-01`;
  return null;
}

function extractTitle(html: string): string | null {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag && clean(titleTag[1]).length > 0) return clean(titleTag[1]);
  const ogTitle = findMetaContent(html, "og:title");
  if (ogTitle) return clean(ogTitle);
  return null;
}

interface ExtractedMetadata {
  title: string | null;
  doi: string | null;
  authors: string[];
  publicationDate: string | null;
  sourceType: SourceType;
}

function extractMetadata(html: string): ExtractedMetadata {
  const citationDoiRaw = findMetaContent(html, "citation_doi");
  let doi = citationDoiRaw ? normalizeDoi(citationDoiRaw) : null;
  if (!doi) {
    const dcIdentifierRaw = findMetaContent(html, "dc.identifier");
    if (dcIdentifierRaw) doi = normalizeDoi(dcIdentifierRaw);
  }

  const authors = findAllMetaContents(html, "citation_author")
    .map((a) => clean(a))
    .filter((a) => a.length > 0);

  const citationDate = findMetaContent(html, "citation_publication_date");
  const articleDate = findMetaContent(html, "article:published_time");
  const publicationDate = (citationDate && normalizeDate(citationDate)) || (articleDate && normalizeDate(articleDate)) || null;

  return {
    title: extractTitle(html),
    doi,
    authors,
    publicationDate,
    sourceType: citationDoiRaw ? "paper" : "web_page",
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchUrlDocument(url: string, opts?: FetchUrlOptions): Promise<SourceDocument> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = opts?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxRedirects = opts?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookup = opts?.lookup;

  let currentUrl = url;
  let response: Response | undefined;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(currentUrl, { lookup });
    response = await fetchWithTimeout(
      currentUrl,
      {
        redirect: "manual",
        headers: { "User-Agent": userAgent(), Accept: ACCEPTED_CONTENT_TYPES.join(", ") },
      },
      timeoutMs,
    );

    if (REDIRECT_STATUSES.has(response.status)) {
      if (hop === maxRedirects) {
        throw new ResearchSourceError(`Too many redirects fetching ${url}`, SOURCE_ID);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new ResearchSourceError(`Redirect with no Location header from ${currentUrl}`, SOURCE_ID, response.status);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }

  if (!response) {
    throw new ResearchSourceError(`Failed to fetch ${url}`, SOURCE_ID);
  }
  if (!response.ok) {
    throw new ResearchSourceError(`Fetch failed with status ${response.status}`, SOURCE_ID, response.status);
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType.includes("pdf")) {
    throw new ResearchSourceError("PDF extraction not supported yet", SOURCE_ID);
  }
  if (!ACCEPTED_CONTENT_TYPES.some((accepted) => contentType.includes(accepted))) {
    throw new ResearchSourceError(`Unsupported content type: ${contentType || "unknown"}`, SOURCE_ID);
  }

  const body = await readBodyWithLimit(response, maxBodyBytes);
  const isHtml = contentType.includes("html");
  const metadata = isHtml ? extractMetadata(body) : { title: null, doi: null, authors: [], publicationDate: null, sourceType: "web_page" as SourceType };
  const text = isHtml ? stripMarkup(body) : body.trim();

  return {
    title: metadata.title ?? currentUrl,
    url: currentUrl,
    doi: metadata.doi,
    authors: metadata.authors,
    publicationDate: metadata.publicationDate,
    sourceType: metadata.doi ? "paper" : metadata.sourceType,
    text,
    textKind: "page",
    metadata: { contentType, fetchedUrl: currentUrl, originalUrl: url },
  };
}

export class UrlSource implements ResearchSource {
  readonly id = SOURCE_ID;
  readonly description = "Direct fetch of a specific URL. Not searchable; used to pull in a URL an agent already has.";

  isEnabled(): boolean {
    return true;
  }

  async search(_query: SearchQuery): Promise<SearchResult[]> {
    return [];
  }

  async fetch(result: SearchResult): Promise<SourceDocument> {
    if (!result.url) {
      throw new ResearchSourceError("Result has no URL to fetch", this.id);
    }
    return fetchUrlDocument(result.url);
  }
}
