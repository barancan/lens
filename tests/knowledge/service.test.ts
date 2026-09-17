import { describe, expect, it } from "vitest";
import { createKnowledgeService, ProvenanceError } from "@/lib/knowledge/service";
import type { SourceDocument } from "@/lib/research/types";
import { fakeEmbedding, useTestDb } from "../helpers/db";

describe("knowledge service", () => {
  const t = useTestDb();
  const svc = createKnowledgeService({ embed: async (texts: string[]) => texts.map((text) => fakeEmbedding(text)) });

  function doc(overrides: Partial<SourceDocument> = {}): SourceDocument {
    return {
      title: "OSK partial reprogramming reduces epigenetic age in mouse retina",
      url: "https://example.org/osk-retina",
      doi: "10.1000/osk-retina",
      authors: ["Lu, Y.", "Sinclair, D."],
      publicationDate: "2020-12-02",
      sourceType: "paper",
      text: "Partial reprogramming with OSK factors reduced epigenetic age markers in retinal ganglion cells. No teratoma formation was observed in treated animals over the study period.",
      textKind: "full_text",
      metadata: { journal: "Nature" },
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------
  // Claim creation and dedupe
  // ---------------------------------------------------------------------
  describe("createClaim", () => {
    it("creates a claim with source_derived origin by default and a history row", async () => {
      const { node, created } = await svc.createClaim({ statement: "OSK reprogramming reduces epigenetic age." });
      expect(created).toBe(true);
      expect(node.type).toBe("claim");
      expect(node.origin).toBe("source_derived");
      expect(node.status).toBe("unresolved");

      const history = await svc.getClaim(node.id);
      expect(history?.history).toHaveLength(1);
      expect(history?.history[0].reason).toBe("created");
    });

    it("rejects agent_generated origin for claims", async () => {
      await expect(
        svc.createClaim({ statement: "x", origin: "agent_generated" }),
      ).rejects.toThrow(/agent_generated/);
    });

    it("allows operator origin for claims", async () => {
      const { node } = await svc.createClaim({ statement: "Operator-entered claim.", origin: "operator" });
      expect(node.origin).toBe("operator");
    });

    it("dedupes near-identical claims by embedding similarity", async () => {
      const first = await svc.createClaim({ statement: "Partial reprogramming reverses aging markers." });
      const second = await svc.createClaim({ statement: "Partial reprogramming reverses aging markers." });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.node.id).toBe(first.node.id);
    });

    it("does not dedupe clearly different claims", async () => {
      const first = await svc.createClaim({ statement: "OSK factors reduce epigenetic age in retinal cells." });
      const second = await svc.createClaim({ statement: "Caloric restriction extends lifespan in nematodes." });
      expect(second.created).toBe(true);
      expect(second.node.id).not.toBe(first.node.id);
    });
  });

  describe("createObservation / createHypothesis", () => {
    it("defaults observation origin to source_derived and rejects agent_generated", async () => {
      const { node } = await svc.createObservation({ statement: "Mice treated with OSK showed no tumors." });
      expect(node.origin).toBe("source_derived");
      await expect(
        svc.createObservation({ statement: "y", origin: "agent_generated" }),
      ).rejects.toThrow(/agent_generated/);
    });

    it("defaults hypothesis origin to agent_generated", async () => {
      const { node } = await svc.createHypothesis({ statement: "Cyclic OSK dosing may reduce cancer risk." });
      expect(node.origin).toBe("agent_generated");
    });
  });

  // ---------------------------------------------------------------------
  // Insight
  // ---------------------------------------------------------------------
  describe("createInsight", () => {
    it("requires at least one derivedFrom id", async () => {
      await expect(svc.createInsight({ statement: "x", derivedFrom: [] })).rejects.toThrow(/derivedFrom/);
    });

    it("rejects unknown derivedFrom ids", async () => {
      await expect(
        svc.createInsight({ statement: "x", derivedFrom: ["00000000-0000-0000-0000-000000000000"] }),
      ).rejects.toThrow();
    });

    it("is always agent_generated and creates derived_from edges to each source node", async () => {
      const a = await svc.createClaim({ statement: "Claim A about reprogramming safety." });
      const b = await svc.createObservation({ statement: "Observation B about tumor incidence." });

      const { node, created } = await svc.createInsight({
        statement: "Taken together, reprogramming appears safe in this model.",
        derivedFrom: [a.node.id, b.node.id],
      });
      expect(created).toBe(true);
      expect(node.origin).toBe("agent_generated");

      const related = await svc.findRelatedKnowledge(node.id);
      const derivedFromEdges = related.filter((r) => r.direction === "outgoing" && r.edge.relationshipType === "derived_from");
      expect(derivedFromEdges.map((r) => r.node.id).sort()).toEqual([a.node.id, b.node.id].sort());
    });
  });

  // ---------------------------------------------------------------------
  // Question
  // ---------------------------------------------------------------------
  describe("createQuestion", () => {
    it("is open, and creates raises edges from each raisedBy node", async () => {
      const claim = await svc.createClaim({ statement: "Claim that raises a question about durability." });
      const { node } = await svc.createQuestion({
        statement: "How durable is the reprogramming effect after treatment stops?",
        raisedBy: [claim.node.id],
      });
      expect(node.status).toBe("open");

      const detail = await svc.getClaim(claim.node.id);
      expect(detail?.questions.map((q) => q.id)).toContain(node.id);
    });

    it("dedupes near-identical questions by embedding similarity", async () => {
      const first = await svc.createQuestion({ statement: "Does reprogramming increase teratoma risk long term?" });
      const second = await svc.createQuestion({ statement: "Does reprogramming increase teratoma risk long term?" });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.node.id).toBe(first.node.id);
    });
  });

  // ---------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------
  describe("upsertSource", () => {
    it("creates a new source, chunks and embeds it", async () => {
      const result = await svc.upsertSource(doc());
      expect(result.created).toBe(true);
      expect(result.source.metadata.textKind).toBe("full_text");
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].content.length).toBeGreaterThan(0);
    });

    it("dedupes by DOI, case-insensitively", async () => {
      const first = await svc.upsertSource(doc());
      const second = await svc.upsertSource(doc({ doi: first.source.doi!.toUpperCase(), url: "https://example.org/other" }));
      expect(second.created).toBe(false);
      expect(second.source.id).toBe(first.source.id);
    });

    it("dedupes by URL when there is no DOI", async () => {
      const first = await svc.upsertSource(doc({ doi: null, url: "https://example.org/no-doi" }));
      const second = await svc.upsertSource(doc({ doi: null, url: "https://example.org/no-doi", title: "Different title" }));
      expect(second.created).toBe(false);
      expect(second.source.id).toBe(first.source.id);
    });

    it("re-chunks an existing source that previously had no chunks", async () => {
      const first = await svc.upsertSource(doc({ url: "https://example.org/rechunk", doi: "10.1/rechunk" }));
      expect(first.chunks.length).toBeGreaterThan(0);

      // Simulate a partially-ingested source: chunks missing even though full_text is present.
      await t.sql`delete from source_chunks where source_id = ${first.source.id}`;

      const second = await svc.upsertSource(doc({ doi: first.source.doi }));
      expect(second.created).toBe(false);
      expect(second.source.id).toBe(first.source.id);
      expect(second.chunks.length).toBeGreaterThan(0);
    });

    it("stores textKind in metadata", async () => {
      const result = await svc.upsertSource(doc({ url: "https://example.org/abstract-only", doi: null, textKind: "abstract" }));
      expect(result.source.metadata.textKind).toBe("abstract");
    });
  });

  describe("findSource / getSource / listSources / getSourceChunks", () => {
    it("finds a source by doi or url", async () => {
      const { source } = await svc.upsertSource(doc());
      expect((await svc.findSource({ doi: source.doi! }))?.id).toBe(source.id);
      expect((await svc.findSource({ url: source.url! }))?.id).toBe(source.id);
      expect(await svc.findSource({})).toBeNull();
    });

    it("lists sources and filters by type", async () => {
      await svc.upsertSource(doc({ url: "https://example.org/a", doi: "10.1/a" }));
      await svc.upsertSource(doc({ url: "https://example.org/b", doi: "10.1/b", sourceType: "web_page" }));
      const papers = await svc.listSources({ sourceTypes: ["paper"] });
      expect(papers.every((s) => s.sourceType === "paper")).toBe(true);
    });

    it("returns chunks for a source", async () => {
      const { source, chunks } = await svc.upsertSource(doc({ url: "https://example.org/c", doi: "10.1/c" }));
      const fetched = await svc.getSourceChunks(source.id);
      expect(fetched.map((c) => c.id).sort()).toEqual(chunks.map((c) => c.id).sort());
    });
  });

  // ---------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------
  describe("addEvidence", () => {
    async function setup() {
      const source = await svc.upsertSource(doc());
      const claim = await svc.createClaim({ statement: "OSK expression does not cause teratomas in this model." });
      return { source: source.source, claim: claim.node };
    }

    it("happy path: verifies quote, auto-assigns chunk, recomputes confidence and writes history", async () => {
      const { source, claim } = await setup();
      const { evidence, created } = await svc.addEvidence({
        claimId: claim.id,
        sourceId: source.id,
        quote: "No teratoma formation was observed in treated animals over the study period.",
        evidenceType: "supports",
        strength: "strong",
        independence: "independent",
      });
      expect(created).toBe(true);
      expect(evidence.sourceChunkId).not.toBeNull();

      const updated = await svc.getNode(claim.id);
      expect(updated?.confidence).not.toBeNull();
      expect(updated?.status).toBe("supported");

      const detail = await svc.getClaim(claim.id);
      expect(detail?.history.some((h) => h.reason === "evidence added")).toBe(true);
    });

    it("matches quotes despite whitespace/case/unicode-quote differences", async () => {
      const { source, claim } = await setup();
      const { created } = await svc.addEvidence({
        claimId: claim.id,
        sourceId: source.id,
        quote: "NO   TERATOMA formation   was observed", // different case + collapsed spacing
        evidenceType: "supports",
      });
      expect(created).toBe(true);
    });

    it("is idempotent on (claim, source, quote)", async () => {
      const { source, claim } = await setup();
      const quote = "No teratoma formation was observed in treated animals over the study period.";
      const first = await svc.addEvidence({ claimId: claim.id, sourceId: source.id, quote, evidenceType: "supports" });
      const second = await svc.addEvidence({ claimId: claim.id, sourceId: source.id, quote, evidenceType: "supports" });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.evidence.id).toBe(first.evidence.id);
    });

    it("rejects a fabricated quote", async () => {
      const { source, claim } = await setup();
      await expect(
        svc.addEvidence({
          claimId: claim.id,
          sourceId: source.id,
          quote: "This sentence does not appear anywhere in the source.",
          evidenceType: "supports",
        }),
      ).rejects.toThrow(ProvenanceError);
    });

    it("rejects a missing source", async () => {
      const { claim } = await setup();
      await expect(
        svc.addEvidence({
          claimId: claim.id,
          sourceId: "00000000-0000-0000-0000-000000000000",
          quote: "anything",
          evidenceType: "supports",
        }),
      ).rejects.toThrow(ProvenanceError);
    });

    it("rejects an insight as the target", async () => {
      const { source, claim } = await setup();
      const insight = await svc.createInsight({ statement: "An interpretive insight.", derivedFrom: [claim.id] });
      await expect(
        svc.addEvidence({
          claimId: insight.node.id,
          sourceId: source.id,
          quote: "No teratoma formation was observed in treated animals over the study period.",
          evidenceType: "supports",
        }),
      ).rejects.toThrow(ProvenanceError);
    });

    it("rejects a question as the target", async () => {
      const { source } = await setup();
      const question = await svc.createQuestion({ statement: "Is this durable long term?" });
      await expect(
        svc.addEvidence({
          claimId: question.node.id,
          sourceId: source.id,
          quote: "No teratoma formation was observed in treated animals over the study period.",
          evidenceType: "supports",
        }),
      ).rejects.toThrow(ProvenanceError);
    });

    it("rejects an empty quote", async () => {
      const { source, claim } = await setup();
      await expect(
        svc.addEvidence({ claimId: claim.id, sourceId: source.id, quote: "   ", evidenceType: "supports" }),
      ).rejects.toThrow(ProvenanceError);
    });
  });

  describe("getEvidenceForClaim / getEvidenceAgainstClaim", () => {
    it("splits evidence into for/against", async () => {
      const { source } = await svc.upsertSource(
        doc({
          url: "https://example.org/mixed",
          doi: "10.1/mixed",
          text: "The treatment improved markers of aging. However, a separate cohort showed no significant effect.",
        }),
      );
      const claim = await svc.createClaim({ statement: "The treatment improves markers of aging." });
      await svc.addEvidence({
        claimId: claim.node.id,
        sourceId: source.id,
        quote: "The treatment improved markers of aging.",
        evidenceType: "supports",
      });
      await svc.addEvidence({
        claimId: claim.node.id,
        sourceId: source.id,
        quote: "a separate cohort showed no significant effect",
        evidenceType: "contradicts",
      });

      const forEv = await svc.getEvidenceForClaim(claim.node.id);
      const againstEv = await svc.getEvidenceAgainstClaim(claim.node.id);
      expect(forEv).toHaveLength(1);
      expect(againstEv).toHaveLength(1);
      expect(forEv[0].evidenceType).toBe("supports");
      expect(againstEv[0].evidenceType).toBe("contradicts");
    });
  });

  describe("listEvidence", () => {
    it("includes the claim statement and supports filters", async () => {
      const { source } = await svc.upsertSource(doc({ url: "https://example.org/list-ev", doi: "10.1/list-ev" }));
      const claim = await svc.createClaim({ statement: "Listing evidence claim." });
      await svc.addEvidence({
        claimId: claim.node.id,
        sourceId: source.id,
        quote: "No teratoma formation was observed in treated animals over the study period.",
        evidenceType: "supports",
      });
      const items = await svc.listEvidence({ claimId: claim.node.id });
      expect(items).toHaveLength(1);
      expect(items[0].claimStatement).toBe("Listing evidence claim.");
      expect(items[0].source.id).toBe(source.id);
    });
  });

  // ---------------------------------------------------------------------
  // Claim detail
  // ---------------------------------------------------------------------
  describe("getClaim", () => {
    it("returns null for an unknown id", async () => {
      expect(await svc.getClaim("00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("assembles supporting/contradicting/contextual evidence, sources and history", async () => {
      const { source } = await svc.upsertSource(
        doc({
          url: "https://example.org/detail",
          doi: "10.1/detail",
          text: "Effect A was observed. Effect B contradicts prior work. Effect C provides background context only.",
        }),
      );
      const claim = await svc.createClaim({ statement: "Claim with a full evidence profile." });
      await svc.addEvidence({ claimId: claim.node.id, sourceId: source.id, quote: "Effect A was observed.", evidenceType: "supports" });
      await svc.addEvidence({ claimId: claim.node.id, sourceId: source.id, quote: "Effect B contradicts prior work.", evidenceType: "contradicts" });
      await svc.addEvidence({ claimId: claim.node.id, sourceId: source.id, quote: "Effect C provides background context only.", evidenceType: "contextualizes" });

      const detail = await svc.getClaim(claim.node.id);
      expect(detail?.supporting).toHaveLength(1);
      expect(detail?.contradicting).toHaveLength(1);
      expect(detail?.contextual).toHaveLength(1);
      expect(detail?.sources.map((s) => s.id)).toEqual([source.id]);
      expect(detail?.history.length).toBeGreaterThanOrEqual(2); // created + evidence added
    });
  });

  // ---------------------------------------------------------------------
  // Graph
  // ---------------------------------------------------------------------
  describe("linkKnowledge / findRelatedKnowledge", () => {
    it("rejects self-links", async () => {
      const a = await svc.createClaim({ statement: "Self-link claim." });
      await expect(
        svc.linkKnowledge({ fromId: a.node.id, toId: a.node.id, relationshipType: "related_to" }),
      ).rejects.toThrow();
    });

    it("is idempotent and findRelatedKnowledge reports both directions", async () => {
      const a = await svc.createClaim({ statement: "Claim A for linking." });
      const b = await svc.createClaim({ statement: "Claim B for linking." });

      const first = await svc.linkKnowledge({ fromId: a.node.id, toId: b.node.id, relationshipType: "related_to" });
      const second = await svc.linkKnowledge({ fromId: a.node.id, toId: b.node.id, relationshipType: "related_to" });
      expect(second.id).toBe(first.id);

      const fromA = await svc.findRelatedKnowledge(a.node.id);
      expect(fromA.some((r) => r.direction === "outgoing" && r.node.id === b.node.id)).toBe(true);

      const fromB = await svc.findRelatedKnowledge(b.node.id);
      expect(fromB.some((r) => r.direction === "incoming" && r.node.id === a.node.id)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // Confidence
  // ---------------------------------------------------------------------
  describe("updateConfidence", () => {
    it("updates the node and writes a history row", async () => {
      const { node } = await svc.createClaim({ statement: "Claim for manual confidence update." });
      const updated = await svc.updateConfidence(node.id, { confidence: 0.8, status: "supported", reason: "manual override" });
      expect(updated?.confidence).toBeCloseTo(0.8, 5);
      expect(updated?.status).toBe("supported");

      const detail = await svc.getClaim(node.id);
      expect(detail?.history.some((h) => h.reason === "manual override")).toBe(true);
    });
  });

  describe("recomputeConfidence", () => {
    it("never overrides a superseded status", async () => {
      const { node } = await svc.createClaim({ statement: "Claim that gets superseded." });
      await svc.updateNodeStatus(node.id, "superseded", "replaced by newer claim");
      const recomputed = await svc.recomputeConfidence(node.id, "recompute attempt");
      expect(recomputed?.status).toBe("superseded");
    });

    it("skips questions and insights", async () => {
      const question = await svc.createQuestion({ statement: "A question that should not get a confidence score." });
      const recomputed = await svc.recomputeConfidence(question.node.id, "recompute attempt");
      expect(recomputed?.confidence).toBeNull();
      expect(recomputed?.status).toBe("open");
    });
  });

  // ---------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------
  describe("backfillEmbeddings", () => {
    it("embeds nodes and chunks that are missing an embedding (e.g. seeded questions)", async () => {
      // Simulate a seeded row inserted without going through the service (no embedding).
      const [seeded] = await t.sql`
        insert into knowledge_nodes (type, statement, status, origin)
        values ('question', 'Seeded-style open question with no embedding.', 'open', 'operator')
        returning id
      `;
      const { source } = await svc.upsertSource(doc({ url: "https://example.org/backfill", doi: "10.1/backfill" }));
      await t.sql`update source_chunks set embedding = null where source_id = ${source.id}`;

      const result = await svc.backfillEmbeddings(10);
      expect(result.nodes).toBeGreaterThanOrEqual(1);
      expect(result.chunks).toBeGreaterThanOrEqual(1);

      const [row] = await t.sql`select embedding is not null as has_embedding from knowledge_nodes where id = ${seeded.id}`;
      expect(row.has_embedding).toBe(true);
    });
  });

  describe("stats", () => {
    it("reports counts by type, status, and totals", async () => {
      const claim = await svc.createClaim({ statement: "Stats claim." });
      const source = await svc.upsertSource(doc({ url: "https://example.org/stats", doi: "10.1/stats" }));
      await svc.addEvidence({
        claimId: claim.node.id,
        sourceId: source.source.id,
        quote: "No teratoma formation was observed in treated animals over the study period.",
        evidenceType: "supports",
      });
      const b = await svc.createObservation({ statement: "Stats observation." });
      await svc.linkKnowledge({ fromId: claim.node.id, toId: b.node.id, relationshipType: "related_to" });

      const s = await svc.stats();
      expect(s.nodesByType.claim).toBeGreaterThanOrEqual(1);
      expect(s.nodesByType.observation).toBeGreaterThanOrEqual(1);
      expect(s.sources).toBeGreaterThanOrEqual(1);
      expect(s.evidence).toBeGreaterThanOrEqual(1);
      expect(s.edges).toBeGreaterThanOrEqual(1);
    });
  });
});
