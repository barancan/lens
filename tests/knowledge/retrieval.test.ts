import { describe, expect, it } from "vitest";
import { createKnowledgeService } from "@/lib/knowledge/service";
import { renderKnowledgeContext, type KnowledgeContext } from "@/lib/knowledge/retrieval";
import type { EvidenceWithSource, KnowledgeNode } from "@/lib/types";
import type { SourceDocument } from "@/lib/research/types";
import { fakeEmbedding, useTestDb } from "../helpers/db";

describe("searchKnowledge (hybrid retrieval)", () => {
  useTestDb();
  const svc = createKnowledgeService({ embed: async (texts: string[]) => texts.map((text) => fakeEmbedding(text)) });

  function doc(overrides: Partial<SourceDocument> = {}): SourceDocument {
    return {
      title: "Reference source",
      url: "https://example.org/ref",
      doi: "10.1/ref",
      authors: [],
      publicationDate: "2021-01-01",
      sourceType: "paper",
      text: "Filler background text.",
      textKind: "full_text",
      metadata: {},
      ...overrides,
    };
  }

  it("ranks the semantically relevant claim first", async () => {
    const query = "OSK partial reprogramming reduces epigenetic age without causing teratomas";
    const relevant = await svc.createClaim({
      statement: "OSK partial reprogramming reduces epigenetic age without causing teratomas in treated mice.",
    });
    await svc.createClaim({ statement: "Caloric restriction extends lifespan in Drosophila independent of insulin signaling." });

    const ctx = await svc.searchKnowledge(query, { includeChunks: false });
    expect(ctx.nodes.length).toBeGreaterThan(0);
    expect(ctx.nodes[0].node.id).toBe(relevant.node.id);
  });

  it("filters by node type", async () => {
    const statement = "Shared statement wording about reprogramming outcomes in this cohort.";
    const claim = await svc.createClaim({ statement });
    await svc.createObservation({ statement: `${statement} Direct observation record.` });

    const ctx = await svc.searchKnowledge("reprogramming outcomes cohort", { types: ["claim"], includeChunks: false });
    expect(ctx.nodes.every((n) => n.node.type === "claim")).toBe(true);
    expect(ctx.nodes.some((n) => n.node.id === claim.node.id)).toBe(true);
  });

  it("filters by tag", async () => {
    const tagged = await svc.createClaim({ statement: "Tagged claim about senolytic combination therapy.", tags: ["important"] });
    await svc.createClaim({ statement: "Untagged claim about senolytic combination therapy variants." });

    const ctx = await svc.searchKnowledge("senolytic combination therapy", { tags: ["important"], includeChunks: false });
    expect(ctx.nodes.every((n) => n.node.tags.includes("important"))).toBe(true);
    expect(ctx.nodes.some((n) => n.node.id === tagged.node.id)).toBe(true);
  });

  it("filters by minConfidence", async () => {
    const confident = await svc.createClaim({ statement: "Confident claim about rapamycin dosing schedules." });
    await svc.updateConfidence(confident.node.id, { confidence: 0.8, status: "supported", reason: "test setup" });

    const unconfident = await svc.createClaim({ statement: "Unconfident claim about rapamycin dosing schedules." });
    await svc.updateConfidence(unconfident.node.id, { confidence: 0.1, status: "weak", reason: "test setup" });

    const ctx = await svc.searchKnowledge("rapamycin dosing schedules", { minConfidence: 0.5, includeChunks: false });
    expect(ctx.nodes.some((n) => n.node.id === confident.node.id)).toBe(true);
    expect(ctx.nodes.some((n) => n.node.id === unconfident.node.id)).toBe(false);
  });

  it("filters by evidenceTypes (node must have >=1 matching evidence)", async () => {
    const { source } = await svc.upsertSource(
      doc({
        url: "https://example.org/ev-filter",
        doi: "10.1/ev-filter",
        text: "This cohort showed marked improvement in biomarkers. A separate group showed a contradictory decline.",
      }),
    );
    const claim = await svc.createClaim({ statement: "Biomarker improvement claim for evidence type filtering." });
    await svc.addEvidence({
      claimId: claim.node.id,
      sourceId: source.id,
      quote: "A separate group showed a contradictory decline.",
      evidenceType: "contradicts",
    });

    const onlySupports = await svc.searchKnowledge("biomarker improvement claim evidence type filtering", {
      evidenceTypes: ["supports"],
      includeChunks: false,
    });
    expect(onlySupports.nodes.some((n) => n.node.id === claim.node.id)).toBe(false);

    await svc.addEvidence({
      claimId: claim.node.id,
      sourceId: source.id,
      quote: "This cohort showed marked improvement in biomarkers.",
      evidenceType: "supports",
    });

    const withSupports = await svc.searchKnowledge("biomarker improvement claim evidence type filtering", {
      evidenceTypes: ["supports"],
      includeChunks: false,
    });
    expect(withSupports.nodes.some((n) => n.node.id === claim.node.id)).toBe(true);
  });

  it("boosts keyword matches even when vector similarity is weak", async () => {
    await svc.createClaim({ statement: "Senescent cell clearance improves tissue repair outcomes in aged skin." });
    const keywordMatch = await svc.createClaim({
      statement: "Cellular reprogrammed states may reduce fibrosis markers in connective tissue.",
    });

    const ctx = await svc.searchKnowledge("reprogramming", { includeChunks: false, limit: 5 });
    const ranked = ctx.nodes.map((n) => n.node.id);
    expect(ranked[0]).toBe(keywordMatch.node.id);
  });

  it("excludes chunks from sources already represented via top evidence", async () => {
    const { source: usedSource } = await svc.upsertSource(
      doc({
        url: "https://example.org/used",
        doi: "10.1/used",
        title: "Used source",
        text: "Telomerase reactivation restores proliferative capacity in senescent fibroblasts.",
      }),
    );
    const claim = await svc.createClaim({ statement: "Telomerase reactivation restores proliferative capacity in cells." });
    await svc.addEvidence({
      claimId: claim.node.id,
      sourceId: usedSource.id,
      quote: "Telomerase reactivation restores proliferative capacity in senescent fibroblasts.",
      evidenceType: "supports",
      strength: "strong",
    });

    const { source: otherSource } = await svc.upsertSource(
      doc({
        url: "https://example.org/other",
        doi: "10.1/other",
        title: "Other source",
        text: "Telomerase reactivation restores proliferative capacity through a different unstudied mechanism entirely.",
      }),
    );

    const ctx = await svc.searchKnowledge("telomerase reactivation restores proliferative capacity", {
      includeChunks: true,
      chunkLimit: 5,
    });

    expect(ctx.nodes.some((n) => n.node.id === claim.node.id)).toBe(true);
    expect(ctx.chunks.every((c) => c.source.id !== usedSource.id)).toBe(true);
    // The other source's chunk is free to appear since it isn't tied to any top-evidence source.
    expect(ctx.chunks.some((c) => c.source.id === otherSource.id)).toBe(true);
  });
});

describe("renderKnowledgeContext", () => {
  function node(overrides: Partial<KnowledgeNode>): KnowledgeNode {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      type: "claim",
      statement: "A statement.",
      summary: null,
      confidence: 0.7,
      status: "supported",
      origin: "source_derived",
      tags: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function evidence(overrides: Partial<EvidenceWithSource>): EvidenceWithSource {
    return {
      id: "00000000-0000-0000-0000-000000000002",
      claimId: "00000000-0000-0000-0000-000000000001",
      sourceId: "s1",
      sourceChunkId: null,
      quote: "A verbatim quote.",
      evidenceType: "supports",
      strength: "strong",
      independence: "independent",
      notes: null,
      runId: null,
      createdAt: new Date().toISOString(),
      source: {
        id: "s1",
        title: "A source",
        url: null,
        doi: null,
        sourceType: "paper",
        publicationDate: "2022-05-01",
        authors: [],
      },
      ...overrides,
    };
  }

  it("labels insights as AGENT INSIGHT and evidence as SOURCE QUOTE, with a header line", () => {
    const ctx: KnowledgeContext = {
      query: "test query",
      nodes: [
        {
          node: node({ id: "n1", type: "insight", origin: "agent_generated" }),
          similarity: 1,
          supportCount: 0,
          contradictCount: 0,
          topEvidence: [],
        },
        {
          node: node({ id: "n2", type: "claim" }),
          similarity: 0.9,
          supportCount: 1,
          contradictCount: 0,
          topEvidence: [evidence({ id: "e1", claimId: "n2" })],
        },
      ],
      chunks: [
        {
          chunk: { id: "c1", sourceId: "s1", chunkIndex: 0, content: "Excerpt content.", metadata: {} },
          source: { id: "s1", title: "Chunk source", url: null, doi: null, sourceType: "paper", publicationDate: null },
          similarity: 0.5,
        },
      ],
    };

    const rendered = renderKnowledgeContext(ctx);
    expect(rendered).toContain("SOURCE QUOTE / SOURCE EXCERPT");
    expect(rendered).toContain("[AGENT INSIGHT id=n1");
    expect(rendered).toContain("[CLAIM id=n2");
    expect(rendered).toContain('[SOURCE QUOTE source_id=s1 "A source" (2022)] "A verbatim quote."');
    expect(rendered).toContain('[SOURCE EXCERPT source_id=s1 chunk_id=c1 "Chunk source"] Excerpt content.');
  });

  it("truncates to maxChars", () => {
    const ctx: KnowledgeContext = {
      query: "q",
      nodes: [
        {
          node: node({ id: "n1", statement: "x".repeat(1000) }),
          similarity: 1,
          supportCount: 0,
          contradictCount: 0,
          topEvidence: [],
        },
      ],
      chunks: [],
    };
    const rendered = renderKnowledgeContext(ctx, { maxChars: 100 });
    expect(rendered.length).toBeLessThanOrEqual(100);
  });
});
