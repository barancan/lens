import * as evidenceRepo from "@/lib/repo/evidence";
import * as knowledgeRepo from "@/lib/repo/knowledge";
import * as sourcesRepo from "@/lib/repo/sources";
import type {
  EvidenceType,
  EvidenceWithSource,
  KnowledgeNode,
  NodeType,
  NodeStatus,
  Source,
  SourceChunk,
  SourceType,
} from "@/lib/types";

/**
 * Hybrid retrieval over the knowledge graph and raw source material.
 * Structured knowledge (nodes, with their evidence) comes first; raw source
 * excerpts fill in around it, second, and only for sources not already
 * represented in the structured results.
 */

export interface RetrievalDeps {
  embed: (texts: string[]) => Promise<number[][]>;
}

export interface RetrievalFilters {
  types?: NodeType[];
  statuses?: NodeStatus[];
  tags?: string[];
  minConfidence?: number;
  evidenceTypes?: EvidenceType[];
  sourceTypes?: SourceType[];
  publishedAfter?: string;
  limit?: number;
  includeChunks?: boolean;
  chunkLimit?: number;
}

export interface RetrievedNode {
  node: KnowledgeNode;
  similarity: number;
  supportCount: number;
  contradictCount: number;
  topEvidence: EvidenceWithSource[];
}

export interface RetrievedChunk {
  chunk: SourceChunk;
  source: Pick<Source, "id" | "title" | "url" | "doi" | "sourceType" | "publicationDate">;
  similarity: number;
}

export interface KnowledgeContext {
  query: string;
  nodes: RetrievedNode[];
  chunks: RetrievedChunk[];
}

const KEYWORD_BOOST = 0.15;
const CHUNK_SIMILARITY_FLOOR = 0.2;
const STRENGTH_RANK: Record<string, number> = { strong: 2, moderate: 1, weak: 0 };

export async function searchKnowledge(
  deps: RetrievalDeps,
  query: string,
  filters: RetrievalFilters = {},
): Promise<KnowledgeContext> {
  const limit = filters.limit ?? 8;
  const includeChunks = filters.includeChunks ?? true;
  const chunkLimit = filters.chunkLimit ?? 5;

  const [embedding] = await deps.embed([query]);

  const nodeFilters = { types: filters.types, minConfidence: filters.minConfidence, tags: filters.tags };
  const [vectorCandidates, keywordCandidates] = await Promise.all([
    knowledgeRepo.matchKnowledgeNodesByVector(embedding, limit * 3, nodeFilters),
    knowledgeRepo.keywordSearchNodes(query, limit * 3, nodeFilters),
  ]);

  const scoreById = new Map<string, number>();
  for (const c of vectorCandidates) scoreById.set(c.id, c.similarity);
  for (const c of keywordCandidates) scoreById.set(c.id, (scoreById.get(c.id) ?? 0) + KEYWORD_BOOST);

  const candidateIds = Array.from(scoreById.keys());
  let candidateNodes = candidateIds.length > 0 ? await knowledgeRepo.getNodesByIds(candidateIds) : [];

  if (filters.statuses?.length) {
    const allow = new Set(filters.statuses);
    candidateNodes = candidateNodes.filter((n) => allow.has(n.status));
  }

  // Fetch full evidence for surviving candidates once: used both for the
  // evidenceTypes inclusion filter and for the supportCount/topEvidence
  // enrichment below, so a node's displayed evidence is never itself
  // narrowed by the evidenceTypes filter.
  const evidenceByNode = new Map<string, EvidenceWithSource[]>();
  for (const node of candidateNodes) {
    evidenceByNode.set(node.id, await evidenceRepo.getEvidenceWithSourceForNode(node.id));
  }

  if (filters.evidenceTypes?.length) {
    const want = new Set(filters.evidenceTypes);
    candidateNodes = candidateNodes.filter((n) =>
      (evidenceByNode.get(n.id) ?? []).some((e) => want.has(e.evidenceType)),
    );
  }

  candidateNodes.sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0));
  const topNodes = candidateNodes.slice(0, limit);

  const retrievedNodes: RetrievedNode[] = topNodes.map((node) => {
    const evidence = evidenceByNode.get(node.id) ?? [];
    const supportCount = evidence.filter((e) => e.evidenceType === "supports" || e.evidenceType === "replicates").length;
    const contradictCount = evidence.filter(
      (e) => e.evidenceType === "contradicts" || e.evidenceType === "challenges",
    ).length;
    const topEvidence = [...evidence]
      .sort((a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength])
      .slice(0, 2);
    return { node, similarity: scoreById.get(node.id) ?? 0, supportCount, contradictCount, topEvidence };
  });

  let chunks: RetrievedChunk[] = [];
  if (includeChunks) {
    const usedSourceIds = new Set<string>();
    for (const rn of retrievedNodes) {
      for (const e of rn.topEvidence) usedSourceIds.add(e.sourceId);
    }
    chunks = await fetchChunks(embedding, filters, chunkLimit, Array.from(usedSourceIds));
  }

  return { query, nodes: retrievedNodes, chunks };
}

async function fetchChunks(
  embedding: number[],
  filters: RetrievalFilters,
  chunkLimit: number,
  excludeSourceIds: string[],
): Promise<RetrievedChunk[]> {
  const matches = await sourcesRepo.matchSourceChunksByVector(embedding, chunkLimit * 3, {
    sourceTypes: filters.sourceTypes,
    publishedAfter: filters.publishedAfter,
    excludeSourceIds,
  });

  const filtered = matches.filter((m) => m.similarity >= CHUNK_SIMILARITY_FLOOR).slice(0, chunkLimit);
  if (filtered.length === 0) return [];

  const [chunkRows, sources] = await Promise.all([
    sourcesRepo.getChunksByIds(filtered.map((m) => m.id)),
    sourcesRepo.getSourcesByIds(Array.from(new Set(filtered.map((m) => m.sourceId)))),
  ]);
  const chunkById = new Map(chunkRows.map((c) => [c.id, c]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const results: RetrievedChunk[] = [];
  for (const m of filtered) {
    const chunk = chunkById.get(m.id);
    const source = sourceById.get(m.sourceId);
    if (!chunk || !source) continue;
    results.push({
      chunk,
      source: {
        id: source.id,
        title: source.title,
        url: source.url,
        doi: source.doi,
        sourceType: source.sourceType,
        publicationDate: source.publicationDate,
      },
      similarity: m.similarity,
    });
  }
  return results;
}

const NODE_LABEL: Record<NodeType, string> = {
  claim: "CLAIM",
  observation: "OBSERVATION",
  insight: "AGENT INSIGHT",
  question: "QUESTION",
  hypothesis: "HYPOTHESIS",
};

/** Compact, explicitly-labelled text for LLM prompts. Source material is marked distinctly from stored knowledge. */
export function renderKnowledgeContext(ctx: KnowledgeContext, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 12000;
  const lines: string[] = [
    "Knowledge context. Lines marked SOURCE QUOTE / SOURCE EXCERPT are verbatim source material;" +
      " every other line is stored knowledge or agent interpretation, not raw source text.",
    "",
  ];

  for (const rn of ctx.nodes) {
    const n = rn.node;
    const label = NODE_LABEL[n.type];
    const confidenceStr = n.confidence === null ? "null" : n.confidence.toFixed(3);
    lines.push(
      `[${label} id=${n.id} status=${n.status} confidence=${confidenceStr} support=${rn.supportCount} contradict=${rn.contradictCount}] ${n.statement}`,
    );
    for (const e of rn.topEvidence) {
      const year = e.source.publicationDate ? e.source.publicationDate.slice(0, 4) : "n.d.";
      lines.push(`  - [SOURCE QUOTE source_id=${e.sourceId} "${e.source.title}" (${year})] "${e.quote}"`);
    }
  }

  if (ctx.chunks.length > 0) {
    lines.push("");
    for (const rc of ctx.chunks) {
      const excerpt = rc.chunk.content.length > 400 ? `${rc.chunk.content.slice(0, 400)}…` : rc.chunk.content;
      lines.push(`[SOURCE EXCERPT source_id=${rc.source.id} chunk_id=${rc.chunk.id} "${rc.source.title}"] ${excerpt}`);
    }
  }

  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
