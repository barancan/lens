import { describe, expect, it } from "vitest";
import {
  getResearchSource,
  getResearchSources,
  listResearchSources,
  MockResearchSource,
  registerResearchSource,
} from "@/lib/integrations/research/registry";
import type { ResearchSource, SearchQuery, SearchResult, SourceDocument } from "@/lib/research/types";

describe("research source registry", () => {
  it("lists all registered default sources with enabled status", () => {
    const listing = listResearchSources();
    const ids = listing.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["europepmc", "crossref", "url", "web", "bios"]));

    const web = listing.find((s) => s.id === "web");
    expect(web?.enabled).toBe(false);
    const bios = listing.find((s) => s.id === "bios");
    expect(bios?.enabled).toBe(false);
    const europepmc = listing.find((s) => s.id === "europepmc");
    expect(europepmc?.enabled).toBe(true);
    const crossref = listing.find((s) => s.id === "crossref");
    expect(crossref?.enabled).toBe(true);
  });

  it("getResearchSource returns a registered source by id, or undefined", () => {
    expect(getResearchSource("europepmc")?.id).toBe("europepmc");
    expect(getResearchSource("does-not-exist")).toBeUndefined();
  });

  it("getResearchSources returns only enabled sources among the requested ids", () => {
    const sources = getResearchSources(["europepmc", "web", "does-not-exist", "bios"]);
    expect(sources.map((s) => s.id)).toEqual(["europepmc"]);
  });

  it("registerResearchSource adds/overrides a source, honored by lookups", () => {
    class AlwaysDisabledSource implements ResearchSource {
      readonly id = "test-disabled";
      readonly description = "disabled test source";
      isEnabled(): boolean {
        return false;
      }
      async search(_query: SearchQuery): Promise<SearchResult[]> {
        return [];
      }
      async fetch(_result: SearchResult): Promise<SourceDocument> {
        throw new Error("n/a");
      }
    }
    registerResearchSource(new AlwaysDisabledSource());
    expect(getResearchSource("test-disabled")).toBeDefined();
    expect(getResearchSources(["test-disabled"])).toEqual([]);
    expect(listResearchSources().some((s) => s.id === "test-disabled")).toBe(true);
  });
});

describe("MockResearchSource", () => {
  const document: SourceDocument = {
    title: "Mock Title",
    url: "https://example.com/mock",
    doi: null,
    authors: ["A. Uthor"],
    publicationDate: "2020-01-01",
    sourceType: "paper",
    text: "full mock text",
    textKind: "full_text",
    metadata: {},
  };
  const result: SearchResult = {
    sourceId: "mock",
    externalId: "mock:1",
    title: "Mock Title about Reprogramming",
    url: "https://example.com/mock",
    doi: null,
    authors: ["A. Uthor"],
    publicationDate: "2020-01-01",
    sourceType: "paper",
    snippet: "A snippet about cellular reprogramming.",
    metadata: {},
  };
  const source = new MockResearchSource([{ result, document }]);

  it("is enabled", () => {
    expect(source.isEnabled()).toBe(true);
  });

  it("search matches keywords case-insensitively against title/snippet", async () => {
    await expect(source.search({ query: "REPROGRAMMING" })).resolves.toEqual([result]);
    await expect(source.search({ query: "reprogramming" })).resolves.toEqual([result]);
    await expect(source.search({ query: "nonexistent keyword" })).resolves.toEqual([]);
  });

  it("fetch returns the matching document", async () => {
    await expect(source.fetch(result)).resolves.toEqual(document);
  });

  it("fetch throws for an unknown result", async () => {
    await expect(
      source.fetch({ ...result, externalId: "mock:unknown" }),
    ).rejects.toThrow();
  });
});
