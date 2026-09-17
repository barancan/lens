/**
 * Registry of research source adapters. Workflows request sources by id
 * (persisted in the `research_agent` agent setting); the Settings UI lists
 * all known sources with their enabled status.
 */
import type { ResearchSource, SearchQuery, SearchResult, SourceDocument } from "@/lib/research/types";
import { BiosResearchSource } from "@/lib/integrations/bios";
import { CrossrefSource } from "./crossref";
import { EuropePmcSource } from "./europepmc";
import { ResearchSourceError } from "./http";
import { UrlSource } from "./url-fetch";
import { WebSearchSource } from "./web-search";

const registry = new Map<string, ResearchSource>();

function defaultSources(): ResearchSource[] {
  return [new EuropePmcSource(), new CrossrefSource(), new UrlSource(), new WebSearchSource(), new BiosResearchSource()];
}

for (const source of defaultSources()) {
  registry.set(source.id, source);
}

/** Test/extension hook: register (or override) a source in the registry. */
export function registerResearchSource(source: ResearchSource): void {
  registry.set(source.id, source);
}

export function getResearchSource(id: string): ResearchSource | undefined {
  return registry.get(id);
}

/** Returns only the sources named in `enabledIds` that are also currently enabled. */
export function getResearchSources(enabledIds: string[]): ResearchSource[] {
  const result: ResearchSource[] = [];
  for (const id of enabledIds) {
    const source = registry.get(id);
    if (source && source.isEnabled()) result.push(source);
  }
  return result;
}

export interface ResearchSourceListing {
  id: string;
  description: string;
  enabled: boolean;
}

/** All registered sources with their enabled status, for the Settings UI. */
export function listResearchSources(): ResearchSourceListing[] {
  return [...registry.values()].map((source) => ({
    id: source.id,
    description: source.description,
    enabled: source.isEnabled(),
  }));
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

export interface MockResearchEntry {
  result: SearchResult;
  document: SourceDocument;
}

/**
 * In-memory research source for tests. Not registered by default — construct
 * it with fixed (result, document) pairs; `search` does a case-insensitive
 * keyword match against title/snippet, and `fetch` returns the matching doc.
 */
export class MockResearchSource implements ResearchSource {
  readonly id = "mock";
  readonly description = "In-memory research source used only in tests.";
  private readonly entries: MockResearchEntry[];

  constructor(entries: MockResearchEntry[]) {
    this.entries = entries;
  }

  isEnabled(): boolean {
    return true;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const needle = query.query.toLowerCase();
    const matches = this.entries
      .filter((entry) => `${entry.result.title} ${entry.result.snippet ?? ""}`.toLowerCase().includes(needle))
      .map((entry) => entry.result);
    return query.limit ? matches.slice(0, query.limit) : matches;
  }

  async fetch(result: SearchResult): Promise<SourceDocument> {
    const entry = this.entries.find((e) => e.result.externalId === result.externalId && e.result.sourceId === result.sourceId);
    if (!entry) {
      throw new ResearchSourceError(`No mock document for ${result.externalId}`, this.id);
    }
    return entry.document;
  }
}
