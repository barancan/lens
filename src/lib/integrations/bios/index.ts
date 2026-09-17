/**
 * BIOS research source — documented stub.
 *
 * Placeholder for a future integration with a BIOS (biological/bio-industry
 * data) literature or dataset provider. No API is wired up yet; disabled by
 * default. When a concrete provider is chosen, implement `search`/`fetch`
 * following the pattern in `src/lib/integrations/research/europepmc.ts` and
 * flip `isEnabled()` to check for the relevant env var(s).
 */
import type { ResearchSource, SearchQuery, SearchResult, SourceDocument } from "@/lib/research/types";

export class BiosResearchSource implements ResearchSource {
  readonly id = "bios";
  readonly description = "BIOS data source (not yet configured — see doc comment in bios/index.ts).";

  isEnabled(): boolean {
    return false;
  }

  async search(_query: SearchQuery): Promise<SearchResult[]> {
    throw new Error("BIOS integration not configured");
  }

  async fetch(_result: SearchResult): Promise<SourceDocument> {
    throw new Error("BIOS integration not configured");
  }
}
