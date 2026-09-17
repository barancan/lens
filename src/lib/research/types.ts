import type { SourceType } from "@/lib/types";

/**
 * Generic research-source contract. Concrete adapters live in
 * `src/lib/integrations/research/*` and are registered in `./registry.ts`.
 */

export interface SearchQuery {
  query: string;
  limit?: number;
  /** ISO date (YYYY-MM-DD); only return items published on/after this date. */
  publishedAfter?: string;
}

export interface SearchResult {
  /** Adapter id that produced this result, used to route `fetch`. */
  sourceId: string;
  externalId: string;
  title: string;
  url: string | null;
  doi: string | null;
  authors: string[];
  publicationDate: string | null;
  sourceType: SourceType;
  snippet: string | null;
  metadata: Record<string, unknown>;
}

export interface SourceDocument {
  title: string;
  url: string | null;
  doi: string | null;
  authors: string[];
  publicationDate: string | null;
  sourceType: SourceType;
  /** Best available text: full text if open access, otherwise the abstract. */
  text: string;
  /** Whether `text` is full text or only an abstract/snippet. */
  textKind: "full_text" | "abstract" | "page" | "snippet";
  metadata: Record<string, unknown>;
}

export interface ResearchSource {
  readonly id: string;
  readonly description: string;
  /** False when required credentials/config are missing. */
  isEnabled(): boolean;
  search(query: SearchQuery): Promise<SearchResult[]>;
  fetch(result: SearchResult): Promise<SourceDocument>;
}
