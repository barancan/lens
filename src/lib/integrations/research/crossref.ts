/**
 * Crossref adapter: broad DOI-registered literature coverage (journals,
 * posted-content/preprints, etc). No API key required; a contact email is
 * sent via `mailto` for Crossref's "polite pool".
 * https://api.crossref.org/swagger-ui/index.html
 */
import { readEnv } from "@/lib/env";
import type { ResearchSource, SearchQuery, SearchResult, SourceDocument } from "@/lib/research/types";
import type { SourceType } from "@/lib/types";
import { ResearchSourceError, fetchWithTimeout, stripMarkup, userAgent } from "./http";

const WORKS_URL = "https://api.crossref.org/works";

interface CrossrefAuthor {
  given?: string;
  family?: string;
}

interface CrossrefDateParts {
  "date-parts"?: number[][];
}

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  published?: CrossrefDateParts;
  "published-print"?: CrossrefDateParts;
  "published-online"?: CrossrefDateParts;
  abstract?: string;
  URL?: string;
  type?: string;
  "container-title"?: string[];
}

interface CrossrefWorksResponse {
  message?: { items?: CrossrefItem[] };
}

function formatDateParts(parts: number[] | undefined): string | null {
  if (!parts || parts.length === 0) return null;
  const [year, month, day] = parts;
  if (!year) return null;
  const mm = String(month ?? 1).padStart(2, "0");
  const dd = String(day ?? 1).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function publicationDateOf(item: CrossrefItem): string | null {
  const parts =
    item.published?.["date-parts"]?.[0] ??
    item["published-print"]?.["date-parts"]?.[0] ??
    item["published-online"]?.["date-parts"]?.[0];
  return formatDateParts(parts);
}

function authorsOf(item: CrossrefItem): string[] {
  return (item.author ?? [])
    .map((a) => [a.given, a.family].filter(Boolean).join(" ").trim())
    .filter((name) => name.length > 0);
}

export class CrossrefSource implements ResearchSource {
  readonly id = "crossref";
  readonly description = "Crossref: DOI-registered scholarly literature, including preprints.";

  isEnabled(): boolean {
    return true;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const url = new URL(WORKS_URL);
    url.searchParams.set("query", query.query);
    url.searchParams.set("rows", String(query.limit ?? 25));
    url.searchParams.set("select", "DOI,title,author,published,abstract,URL,type,container-title");
    if (query.publishedAfter) {
      url.searchParams.set("filter", `from-pub-date:${query.publishedAfter}`);
    }
    const email = readEnv("CONTACT_EMAIL");
    if (email) {
      url.searchParams.set("mailto", email);
    }

    const res = await fetchWithTimeout(url.toString(), { headers: { "User-Agent": userAgent() } });
    if (!res.ok) {
      throw new ResearchSourceError(`Crossref search failed: ${res.status}`, this.id, res.status);
    }
    const data = (await res.json()) as CrossrefWorksResponse;
    const items = data.message?.items ?? [];

    return items.map((item): SearchResult => {
      const sourceType: SourceType = item.type === "posted-content" ? "preprint" : "paper";
      const abstract = item.abstract ? stripMarkup(item.abstract) : null;
      return {
        sourceId: this.id,
        externalId: item.DOI ?? "",
        title: item.title?.[0] ?? "",
        url: item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : null),
        doi: item.DOI ?? null,
        authors: authorsOf(item),
        publicationDate: publicationDateOf(item),
        sourceType,
        snippet: abstract,
        metadata: {
          type: item.type ?? null,
          containerTitle: item["container-title"]?.[0] ?? null,
          abstract,
        },
      };
    });
  }

  async fetch(result: SearchResult): Promise<SourceDocument> {
    const abstract = result.metadata.abstract as string | null | undefined;
    if (!abstract) {
      throw new ResearchSourceError(`No abstract available for ${result.externalId}`, this.id);
    }
    return {
      title: result.title,
      url: result.url,
      doi: result.doi,
      authors: result.authors,
      publicationDate: result.publicationDate,
      sourceType: result.sourceType,
      text: abstract,
      textKind: "abstract",
      metadata: result.metadata,
    };
  }
}
