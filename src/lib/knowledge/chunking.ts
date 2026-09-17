/**
 * Deterministic text chunking for embedding + retrieval.
 *
 * Splits on paragraph boundaries where possible. Paragraphs longer than
 * `maxChars` fall back to sentence boundaries; sentences still longer than
 * `maxChars` are hard-cut. Adjacent chunks share up to `overlap` characters
 * of trailing context from the previous chunk so retrieval doesn't lose
 * meaning at a boundary. Never returns empty chunks.
 */

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP = 200;

const PARAGRAPH_SPLIT = /\n\s*\n+/;
// Split after sentence-ending punctuation followed by whitespace and (likely)
// the start of a new sentence, or at the end of the string.
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"'(])|(?<=[.!?])\s+$/;

function splitParagraphs(text: string): string[] {
  return text
    .split(PARAGRAPH_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hardSplit(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    parts.push(text.slice(i, i + maxChars));
  }
  return parts;
}

/** Break `text` into units no longer than maxChars: paragraph > sentence > hard cut. */
function unitsFor(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    return sentences.flatMap((s) => unitsFor(s, maxChars));
  }
  return hardSplit(text, maxChars);
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_OVERLAP, maxChars - 1));
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const units: string[] = [];
  for (const paragraph of splitParagraphs(normalized)) {
    units.push(...unitsFor(paragraph, maxChars));
  }
  if (units.length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    flush();
    current = unit;
  }
  flush();

  if (overlap === 0 || chunks.length < 2) return chunks;

  const withOverlap: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prevTail = chunks[i - 1].slice(-overlap).trim();
    const next = prevTail ? `${prevTail}\n\n${chunks[i]}` : chunks[i];
    withOverlap.push(next.length <= maxChars ? next : chunks[i]);
  }
  return withOverlap;
}
