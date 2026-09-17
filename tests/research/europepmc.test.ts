import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EuropePmcSource } from "@/lib/integrations/research/europepmc";
import { ResearchSourceError } from "@/lib/integrations/research/http";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("EuropePmcSource", () => {
  const source = new EuropePmcSource();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps search results", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        resultList: {
          result: [
            {
              id: "12345",
              source: "MED",
              pmid: "12345",
              pmcid: "PMC999",
              doi: "10.1/xyz",
              title: "Partial reprogramming reduces markers of aging",
              authorString: "Smith J, Doe A",
              journalTitle: "Nature Aging",
              firstPublicationDate: "2023-04-01",
              abstractText: "<p>This is the <b>abstract</b>.</p>",
              isOpenAccess: "Y",
              citedByCount: 42,
              pubTypeList: { pubType: ["Journal Article"] },
            },
          ],
        },
      }),
    );

    const results = await source.search({ query: "partial reprogramming" });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.sourceId).toBe("europepmc");
    expect(r.externalId).toBe("MED:12345");
    expect(r.title).toBe("Partial reprogramming reduces markers of aging");
    expect(r.authors).toEqual(["Smith J", "Doe A"]);
    expect(r.doi).toBe("10.1/xyz");
    expect(r.url).toBe("https://europepmc.org/article/MED/12345");
    expect(r.publicationDate).toBe("2023-04-01");
    expect(r.sourceType).toBe("paper");
    expect(r.snippet).toBe("This is the abstract .");
    expect(r.metadata).toMatchObject({
      pmid: "12345",
      pmcid: "PMC999",
      journalTitle: "Nature Aging",
      isOpenAccess: true,
      citedByCount: 42,
      pubTypes: ["Journal Article"],
    });
  });

  it("marks preprints from source PPR or pubType", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        resultList: {
          result: [
            { id: "1", source: "PPR", title: "A preprint", authorString: "" },
            { id: "2", source: "MED", title: "Another", authorString: "", pubTypeList: { pubType: ["preprint"] } },
          ],
        },
      }),
    );
    const results = await source.search({ query: "x" });
    expect(results[0].sourceType).toBe("preprint");
    expect(results[1].sourceType).toBe("preprint");
  });

  it("appends FIRST_PDATE filter when publishedAfter is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ resultList: { result: [] } }));
    await source.search({ query: "aging", publishedAfter: "2022-01-01" });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("query")).toBe("aging AND FIRST_PDATE:[2022-01-01 TO 3000-12-31]");
  });

  it("fetch returns full text when pmcid is open access and full text succeeds", async () => {
    const result = {
      sourceId: "europepmc",
      externalId: "MED:1",
      title: "T",
      url: "https://europepmc.org/article/MED/1",
      doi: null,
      authors: [],
      publicationDate: null,
      sourceType: "paper" as const,
      snippet: "abstract snippet",
      metadata: { pmcid: "PMC1", isOpenAccess: true, abstractText: "the abstract" },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "<article><p>Full text body.</p></article>",
    });
    const doc = await source.fetch(result);
    expect(doc.textKind).toBe("full_text");
    expect(doc.text).toContain("Full text body.");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML",
      expect.anything(),
    );
  });

  it("fetch falls back to abstract when full text fetch fails", async () => {
    const result = {
      sourceId: "europepmc",
      externalId: "MED:1",
      title: "T",
      url: null,
      doi: null,
      authors: [],
      publicationDate: null,
      sourceType: "paper" as const,
      snippet: null,
      metadata: { pmcid: "PMC1", isOpenAccess: true, abstractText: "the abstract text" },
    };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "" });
    const doc = await source.fetch(result);
    expect(doc.textKind).toBe("abstract");
    expect(doc.text).toBe("the abstract text");
  });

  it("fetch uses abstract directly when not open access", async () => {
    const result = {
      sourceId: "europepmc",
      externalId: "MED:1",
      title: "T",
      url: null,
      doi: null,
      authors: [],
      publicationDate: null,
      sourceType: "paper" as const,
      snippet: null,
      metadata: { pmcid: "PMC1", isOpenAccess: false, abstractText: "closed access abstract" },
    };
    const doc = await source.fetch(result);
    expect(doc.textKind).toBe("abstract");
    expect(doc.text).toBe("closed access abstract");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws ResearchSourceError when there is no full text and no abstract", async () => {
    const result = {
      sourceId: "europepmc",
      externalId: "MED:1",
      title: "T",
      url: null,
      doi: null,
      authors: [],
      publicationDate: null,
      sourceType: "paper" as const,
      snippet: null,
      metadata: { pmcid: null, isOpenAccess: false, abstractText: null },
    };
    await expect(source.fetch(result)).rejects.toThrow(ResearchSourceError);
  });
});
