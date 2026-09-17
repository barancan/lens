/**
 * Web search research source — documented stub.
 *
 * There is no general web search provider wired up yet. To add one:
 *   1. Add an env var for the provider's API key (e.g. `BRAVE_API_KEY` or
 *      `TAVILY_API_KEY`) to the schema in `src/lib/env.ts`.
 *   2. Implement `search()` against that provider's REST API, mapping its
 *      results into `SearchResult[]` (see `src/lib/research/types.ts`).
 *   3. Implement `fetch()` — most providers return a snippet only, so this
 *      will likely delegate to `fetchUrlDocument` in `./url-fetch.ts` to get
 *      full page text for a chosen result.
 *   4. Flip `isEnabled()` to check the new env var, and register the source
 *      in `./registry.ts`.
 */
import type { ResearchSource, SearchQuery, SearchResult, SourceDocument } from "@/lib/research/types";

export class WebSearchSource implements ResearchSource {
  readonly id = "web";
  readonly description = "General web search (not yet configured — see doc comment in web-search.ts).";

  isEnabled(): boolean {
    return false;
  }

  async search(_query: SearchQuery): Promise<SearchResult[]> {
    throw new Error("Web search is not configured");
  }

  async fetch(_result: SearchResult): Promise<SourceDocument> {
    throw new Error("Web search is not configured");
  }
}
