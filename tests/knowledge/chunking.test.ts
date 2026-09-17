import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/knowledge/chunking";

describe("chunkText", () => {
  it("returns an empty array for empty/whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("returns a single chunk when the text fits", () => {
    const text = "Partial reprogramming may reduce epigenetic age markers.";
    expect(chunkText(text)).toEqual([text]);
  });

  it("splits on paragraph boundaries when the text is long", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}. `.repeat(20).trim());
    const text = paragraphs.join("\n\n");
    const chunks = chunkText(text, { maxChars: 300, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(300);
    }
  });

  it("falls back to sentence splitting for a single long paragraph", () => {
    const sentence = "OSK expression was induced for a fixed cycle. ";
    const text = sentence.repeat(60).trim();
    const chunks = chunkText(text, { maxChars: 200, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it("falls back to a hard cut for text with no sentence boundaries", () => {
    const text = "x".repeat(1000);
    const chunks = chunkText(text, { maxChars: 100, overlap: 0 });
    expect(chunks).toHaveLength(10);
    for (const c of chunks) expect(c).toHaveLength(100);
  });

  it("never produces empty chunks", () => {
    const text = `${"\n\n".repeat(5)}First paragraph.${"\n\n\n".repeat(3)}Second paragraph.${"\n\n".repeat(4)}`;
    const chunks = chunkText(text, { maxChars: 50, overlap: 0 });
    for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} about reprogramming and aging.`).join(
      " ",
    );
    const a = chunkText(text, { maxChars: 150, overlap: 30 });
    const b = chunkText(text, { maxChars: 150, overlap: 30 });
    expect(a).toEqual(b);
  });

  it("overlaps adjacent chunks with trailing context from the previous chunk", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} content about cellular reprogramming.`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkText(text, { maxChars: 80, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].slice(-20).trim();
      if (prevTail) {
        expect(chunks[i].startsWith(prevTail) || chunks[i].includes(prevTail.slice(0, 5))).toBe(true);
      }
    }
  });
});
