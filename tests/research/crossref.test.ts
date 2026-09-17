import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossrefSource } from "@/lib/integrations/research/crossref";
import { ResearchSourceError } from "@/lib/integrations/research/http";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("CrossrefSource", () => {
  const source = new CrossrefSource();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps works into search results", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        message: {
          items: [
            {
              DOI: "10.1000/xyz123",
              title: ["Reprogramming and the epigenetic clock"],
              author: [{ given: "Jane", family: "Smith" }, { given: "Bob", family: "Lee" }],
              published: { "date-parts": [[2021, 6, 15]] },
              abstract: "<jats:p>An <jats:italic>abstract</jats:italic>.</jats:p>",
              URL: "https://doi.org/10.1000/xyz123",
              type: "journal-article",
              "container-title": ["Cell"],
            },
          ],
        },
      }),
    );

    const results = await source.search({ query: "reprogramming" });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.sourceId).toBe("crossref");
    expect(r.doi).toBe("10.1000/xyz123");
    expect(r.title).toBe("Reprogramming and the epigenetic clock");
    expect(r.authors).toEqual(["Jane Smith", "Bob Lee"]);
    expect(r.publicationDate).toBe("2021-06-15");
    expect(r.sourceType).toBe("paper");
    expect(r.snippet).toBe("An abstract .");
    expect(r.metadata.containerTitle).toBe("Cell");
  });

  it("marks posted-content as preprint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        message: {
          items: [
            {
              DOI: "10.1101/abc",
              title: ["A bioRxiv preprint"],
              type: "posted-content",
              published: { "date-parts": [[2022]] },
            },
          ],
        },
      }),
    );
    const results = await source.search({ query: "x" });
    expect(results[0].sourceType).toBe("preprint");
    // date-parts with only a year pads month/day to 01
    expect(results[0].publicationDate).toBe("2022-01-01");
  });

  it("pads missing month/day in date-parts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        message: {
          items: [
            { DOI: "10.1/a", title: ["T"], published: { "date-parts": [[2020, 3]] } },
          ],
        },
      }),
    );
    const results = await source.search({ query: "x" });
    expect(results[0].publicationDate).toBe("2020-03-01");
  });

  it("adds a from-pub-date filter when publishedAfter is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: { items: [] } }));
    await source.search({ query: "aging", publishedAfter: "2023-01-01" });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("filter")).toBe("from-pub-date:2023-01-01");
  });

  it("fetch returns the abstract", async () => {
    const result = {
      sourceId: "crossref",
      externalId: "10.1/a",
      title: "T",
      url: null,
      doi: "10.1/a",
      authors: [],
      publicationDate: null,
      sourceType: "paper" as const,
      snippet: "abstract text",
      metadata: { abstract: "abstract text" },
    };
    const doc = await source.fetch(result);
    expect(doc.textKind).toBe("abstract");
    expect(doc.text).toBe("abstract text");
  });

  it("fetch throws when there is no abstract", async () => {
    const result = {
      sourceId: "crossref",
      externalId: "10.1/a",
      title: "T",
      url: null,
      doi: "10.1/a",
      authors: [],
      publicationDate: null,
      sourceType: "paper" as const,
      snippet: null,
      metadata: {},
    };
    await expect(source.fetch(result)).rejects.toThrow(ResearchSourceError);
  });
});
