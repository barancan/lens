import { describe, expect, it } from "vitest";
import { ResearchSourceError, stripMarkup, userAgent } from "@/lib/integrations/research/http";

describe("stripMarkup", () => {
  it("removes script, style, nav, header and footer blocks entirely", () => {
    const html = `
      <header>Site header</header>
      <nav>Nav links</nav>
      <script>doEvil();</script>
      <style>.x { color: red }</style>
      <p>Real content.</p>
      <footer>Footer text</footer>
    `;
    const text = stripMarkup(html);
    expect(text).not.toContain("Site header");
    expect(text).not.toContain("Nav links");
    expect(text).not.toContain("doEvil");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("Footer text");
    expect(text).toContain("Real content.");
  });

  it("decodes named and numeric entities", () => {
    const text = stripMarkup("<p>Fish &amp; chips &mdash; caf&#233; &#x2014; na&iuml;ve</p>");
    expect(text).toContain("Fish & chips");
    expect(text).toContain("café");
    expect(text).toContain("naïve");
  });

  it("keeps paragraph breaks for block elements", () => {
    const text = stripMarkup("<div><p>First paragraph.</p><p>Second paragraph.</p></div>");
    const parts = text.split("\n\n").filter(Boolean);
    expect(parts.some((p) => p.includes("First paragraph."))).toBe(true);
    expect(parts.some((p) => p.includes("Second paragraph."))).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it("collapses irregular whitespace within a block", () => {
    const text = stripMarkup("<p>Too    many\n\t  spaces</p>");
    expect(text).toBe("Too many spaces");
  });

  it("strips inline tags without preserving them", () => {
    const text = stripMarkup("<p>An <b>important</b> point</p>");
    expect(text).not.toContain("<b>");
    expect(text).toContain("important");
  });
});

describe("userAgent", () => {
  it("returns a LENS-branded user agent string", () => {
    expect(userAgent()).toMatch(/^LENS-research-agent\/0\.1/);
  });
});

describe("ResearchSourceError", () => {
  it("carries sourceId and optional status", () => {
    const err = new ResearchSourceError("boom", "europepmc", 503);
    expect(err).toBeInstanceOf(Error);
    expect(err.sourceId).toBe("europepmc");
    expect(err.status).toBe(503);
    expect(err.message).toBe("boom");
  });

  it("status is optional", () => {
    const err = new ResearchSourceError("boom", "crossref");
    expect(err.status).toBeUndefined();
  });
});
