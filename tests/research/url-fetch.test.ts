import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Guard against any accidental real DNS resolution: every test either passes
// an explicit `lookup`, or (for the UrlSource delegation test) relies on this
// module-level mock of node:dns.
vi.mock("node:dns", () => ({
  promises: {
    lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  },
}));

import {
  assertPublicUrl,
  fetchUrlDocument,
  isPrivateAddress,
  UrlSource,
  type DnsLookupFn,
} from "@/lib/integrations/research/url-fetch";
import { ResearchSourceError } from "@/lib/integrations/research/http";

describe("isPrivateAddress", () => {
  it.each([
    ["10.1.2.3"],
    ["172.16.0.5"],
    ["172.31.255.255"],
    ["192.168.1.1"],
    ["127.0.0.1"],
    ["169.254.1.1"],
    ["100.64.0.1"],
    ["100.100.100.100"],
    ["0.0.0.0"],
    ["::1"],
    ["fc00::1"],
    ["fd12:3456::1"],
    ["fe80::1"],
    ["::ffff:127.0.0.1"],
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["93.184.216.34"], ["2606:4700:4700::1111"]])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it("does not misclassify 172.15.x or 172.32.x as private (outside the /12)", () => {
    expect(isPrivateAddress("172.15.255.255")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
  });
});

function publicLookup(address = "93.184.216.34"): DnsLookupFn {
  return async () => [{ address, family: 4 }];
}

function privateLookup(address = "10.0.0.5"): DnsLookupFn {
  return async () => [{ address, family: 4 }];
}

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(ResearchSourceError);
  });

  it("rejects localhost without doing a DNS lookup", async () => {
    const lookup = vi.fn();
    await expect(assertPublicUrl("http://localhost/", { lookup })).rejects.toThrow(ResearchSourceError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects URLs with embedded credentials", async () => {
    await expect(assertPublicUrl("http://user:pass@example.com/", { lookup: publicLookup() })).rejects.toThrow(
      ResearchSourceError,
    );
  });

  it("rejects hosts that resolve to a private address", async () => {
    await expect(assertPublicUrl("http://internal.example/", { lookup: privateLookup() })).rejects.toThrow(
      ResearchSourceError,
    );
  });

  it("accepts a host resolving only to public addresses", async () => {
    await expect(assertPublicUrl("https://example.com/", { lookup: publicLookup() })).resolves.toBeInstanceOf(URL);
  });
});

function htmlResponse(html: string, contentType = "text/html; charset=utf-8") {
  return new Response(html, { status: 200, headers: { "content-type": contentType } });
}

describe("fetchUrlDocument", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks a redirect that leads to a private address", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://internal.example/" } }),
    );
    const lookup: DnsLookupFn = async (hostname) => {
      if (hostname === "public.example") return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "10.0.0.5", family: 4 }];
    };
    await expect(fetchUrlDocument("http://public.example/", { lookup })).rejects.toThrow(ResearchSourceError);
    // Only the first hop should have been fetched; the redirect target was blocked before a second fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects PDF content types", async () => {
    fetchMock.mockResolvedValueOnce(new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }));
    await expect(fetchUrlDocument("https://example.com/paper.pdf", { lookup: publicLookup() })).rejects.toThrow(
      /PDF extraction not supported/,
    );
  });

  it("rejects unsupported content types", async () => {
    fetchMock.mockResolvedValueOnce(new Response("binary", { status: 200, headers: { "content-type": "application/octet-stream" } }));
    await expect(fetchUrlDocument("https://example.com/file.bin", { lookup: publicLookup() })).rejects.toThrow(
      ResearchSourceError,
    );
  });

  it("rejects oversized bodies", async () => {
    const bigHtml = `<html><body>${"a".repeat(1000)}</body></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(bigHtml));
    await expect(
      fetchUrlDocument("https://example.com/big", { lookup: publicLookup(), maxBodyBytes: 100 }),
    ).rejects.toThrow(/exceeds/);
  });

  it("extracts title, doi, authors and publication date from HTML metadata", async () => {
    const html = `<!doctype html>
      <html><head>
        <title>Partial Reprogramming Reverses Aging Markers</title>
        <meta name="citation_doi" content="10.1234/example.doi">
        <meta name="citation_author" content="Jane Smith">
        <meta name="citation_author" content="Bob Lee">
        <meta name="citation_publication_date" content="2023/05/12">
      </head><body><p>Some page text.</p></body></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));
    const doc = await fetchUrlDocument("https://example.com/article", { lookup: publicLookup() });
    expect(doc.title).toBe("Partial Reprogramming Reverses Aging Markers");
    expect(doc.doi).toBe("10.1234/example.doi");
    expect(doc.authors).toEqual(["Jane Smith", "Bob Lee"]);
    expect(doc.publicationDate).toBe("2023-05-12");
    expect(doc.sourceType).toBe("paper");
    expect(doc.textKind).toBe("page");
    expect(doc.text).toContain("Some page text.");
  });

  it("falls back to web_page sourceType and og:title when no citation metadata is present", async () => {
    const html = `<!doctype html><html><head>
        <meta property="og:title" content="A Blog Post">
      </head><body><div>Body text here.</div></body></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));
    const doc = await fetchUrlDocument("https://example.com/blog", { lookup: publicLookup() });
    expect(doc.title).toBe("A Blog Post");
    expect(doc.doi).toBeNull();
    expect(doc.sourceType).toBe("web_page");
  });

  it("follows a redirect to a public host and returns its document", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://example.com/final" } }))
      .mockResolvedValueOnce(htmlResponse("<html><head><title>Final Page</title></head><body>ok</body></html>"));
    const doc = await fetchUrlDocument("https://example.com/start", { lookup: publicLookup() });
    expect(doc.title).toBe("Final Page");
    expect(doc.url).toBe("https://example.com/final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("UrlSource", () => {
  it("search returns no results (not a searchable index)", async () => {
    const source = new UrlSource();
    await expect(source.search({ query: "anything" })).resolves.toEqual([]);
  });

  it("fetch delegates to fetchUrlDocument via the result's url", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(htmlResponse("<html><head><title>Delegated</title></head><body>x</body></html>"));
    vi.stubGlobal("fetch", fetchMock);
    const source = new UrlSource();
    const doc = await source.fetch({
      sourceId: "url",
      externalId: "https://example.com/",
      title: "",
      url: "https://example.com/",
      doi: null,
      authors: [],
      publicationDate: null,
      sourceType: "web_page",
      snippet: null,
      metadata: {},
    });
    expect(doc.title).toBe("Delegated");
    vi.unstubAllGlobals();
  });
});
