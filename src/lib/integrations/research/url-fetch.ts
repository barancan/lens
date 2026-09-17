/**
 * Fetches an arbitrary URL as a research source, with an SSRF guard: only
 * public http(s) hosts are allowed, redirects are followed manually and
 * re-validated at each hop, and the response is capped in size and type.
 */
import { promises as dnsPromises } from "node:dns";
import { BlockList, isIP } from "node:net";
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

// Non-public ranges. BlockList also matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 rules.
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::", 96], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, prefix, "ipv6");

/** True for loopback, private, link-local, CGNAT, multicast, reserved or unparseable addresses (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family === 6) return BLOCKED.check(address, "ipv6");
  return true;
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
