/**
 * Europe PMC adapter: covers PubMed plus preprints (bioRxiv/medRxiv via the
 * Europe PMC "PPR" source). No API key required.
 * https://europepmc.org/RestfulWebService
 */
import type { ResearchSource, SearchQuery, SearchResult, SourceDocument } from "@/lib/research/types";
import type { SourceType } from "@/lib/types";
import { ResearchSourceError, fetchWithTimeout, stripMarkup, userAgent } from "./http";

const SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const SNIPPET_MAX_LENGTH = 500;

interface EuropePmcResultItem {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  firstPublicationDate?: string;
  abstractText?: string;
  isOpenAccess?: string;
  citedByCount?: number;
  pubTypeList?: { pubType?: string[] };
}

interface EuropePmcSearchResponse {
  resultList?: { result?: EuropePmcResultItem[] };
}

function toSourceType(item: EuropePmcResultItem): SourceType {
  const pubTypes = item.pubTypeList?.pubType ?? [];
  if (item.source === "PPR" || pubTypes.some((t) => t.toLowerCase().includes("preprint"))) {
    return "preprint";
  }
  return "paper";
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export class EuropePmcSource implements ResearchSource {
  readonly id = "europepmc";
  readonly description = "Europe PMC: PubMed literature plus preprints (bioRxiv/medRxiv).";

  isEnabled(): boolean {
    return true;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    let q = query.query;
    if (query.publishedAfter) {
      q += ` AND FIRST_PDATE:[${query.publishedAfter} TO 3000-12-31]`;
    }
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", String(query.limit ?? 25));

    const res = await fetchWithTimeout(url.toString(), { headers: { "User-Agent": userAgent() } });
    if (!res.ok) {
      throw new ResearchSourceError(`Europe PMC search failed: ${res.status}`, this.id, res.status);
    }
    const data = (await res.json()) as EuropePmcSearchResponse;
    const items = data.resultList?.result ?? [];

    return items.map((item): SearchResult => {
      const source = item.source ?? "MED";
      const id = item.id ?? item.pmid ?? "";
      const abstractText = item.abstractText ?? null;
      const snippet = abstractText ? truncate(stripMarkup(abstractText), SNIPPET_MAX_LENGTH) : null;
      return {
        sourceId: this.id,
        externalId: `${source}:${id}`,
        title: item.title ?? "",
        url: `https://europepmc.org/article/${source}/${id}`,
        doi: item.doi ?? null,
        authors: item.authorString ? item.authorString.split(", ").filter(Boolean) : [],
        publicationDate: item.firstPublicationDate ?? null,
        sourceType: toSourceType(item),
        snippet,
        metadata: {
          pmid: item.pmid ?? null,
          pmcid: item.pmcid ?? null,
          journalTitle: item.journalTitle ?? null,
          isOpenAccess: item.isOpenAccess === "Y",
          citedByCount: item.citedByCount ?? null,
          pubTypes: item.pubTypeList?.pubType ?? [],
          abstractText,
        },
      };
    });
  }

  async fetch(result: SearchResult): Promise<SourceDocument> {
    const pmcid = result.metadata.pmcid as string | null | undefined;
    const isOpenAccess = Boolean(result.metadata.isOpenAccess);
    const abstractText = (result.metadata.abstractText as string | null | undefined) ?? null;

    if (pmcid && isOpenAccess) {
      try {
        const res = await fetchWithTimeout(
          `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
          { headers: { "User-Agent": userAgent() } },
        );
        if (res.ok) {
          const xml = await res.text();
          const text = stripMarkup(xml);
          if (text) {
            return this.toDocument(result, text, "full_text");
          }
        }
      } catch {
        // fall through to abstract fallback below
      }
    }

    if (!abstractText) {
      throw new ResearchSourceError(
        `No full text or abstract available for ${result.externalId}`,
        this.id,
      );
    }
    return this.toDocument(result, stripMarkup(abstractText), "abstract");
  }

  private toDocument(result: SearchResult, text: string, textKind: SourceDocument["textKind"]): SourceDocument {
    return {
      title: result.title,
      url: result.url,
      doi: result.doi,
      authors: result.authors,
      publicationDate: result.publicationDate,
      sourceType: result.sourceType,
      text,
      textKind,
      metadata: result.metadata,
    };
  }
}
