import { describe, expect, it } from "vitest";
import { computeConfidence } from "@/lib/knowledge/confidence";

describe("computeConfidence", () => {
  it("returns null/unresolved with no evidence", () => {
    expect(computeConfidence([])).toEqual({ confidence: null, status: "unresolved" });
  });

  it("returns null/unresolved when only contextualizing evidence exists", () => {
    expect(
      computeConfidence([{ evidenceType: "contextualizes", strength: "strong", independence: "independent" }]),
    ).toEqual({ confidence: null, status: "unresolved" });
  });

  it("is supported with strong, independent, unanimous support", () => {
    const result = computeConfidence([
      { evidenceType: "supports", strength: "strong", independence: "independent" },
      { evidenceType: "replicates", strength: "strong", independence: "independent" },
    ]);
    expect(result.status).toBe("supported");
    expect(result.confidence).not.toBeNull();
    expect(result.confidence!).toBeGreaterThanOrEqual(0.65);
  });

  it("weighs independence: an independent source counts more than a same-group one", () => {
    const independent = computeConfidence([{ evidenceType: "supports", strength: "moderate", independence: "independent" }]);
    const sameGroup = computeConfidence([{ evidenceType: "supports", strength: "moderate", independence: "same_group" }]);
    expect(independent.confidence!).toBeGreaterThan(sameGroup.confidence!);
  });

  it("is weak when contradicted strongly with no support", () => {
    const result = computeConfidence([
      { evidenceType: "contradicts", strength: "strong", independence: "independent" },
    ]);
    expect(result.status).toBe("weak");
    expect(result.confidence!).toBeLessThanOrEqual(0.35);
  });

  it("is contested when support and contradiction are comparably matched", () => {
    const result = computeConfidence([
      { evidenceType: "supports", strength: "moderate", independence: "independent" },
      { evidenceType: "contradicts", strength: "moderate", independence: "independent" },
    ]);
    expect(result.status).toBe("contested");
    expect(result.confidence).not.toBeNull();
  });

  it("is not contested when contradiction is negligible relative to support", () => {
    const result = computeConfidence([
      { evidenceType: "supports", strength: "strong", independence: "independent" },
      { evidenceType: "supports", strength: "strong", independence: "independent" },
      { evidenceType: "supports", strength: "strong", independence: "independent" },
      { evidenceType: "contradicts", strength: "weak", independence: "same_group" },
    ]);
    expect(result.status).not.toBe("contested");
  });

  it("weighs replicates more than a plain support", () => {
    const supports = computeConfidence([{ evidenceType: "supports", strength: "moderate", independence: "independent" }]);
    const replicates = computeConfidence([{ evidenceType: "replicates", strength: "moderate", independence: "independent" }]);
    expect(replicates.confidence!).toBeGreaterThan(supports.confidence!);
  });

  it("weighs challenges less than a plain contradiction", () => {
    const contradicts = computeConfidence([{ evidenceType: "contradicts", strength: "moderate", independence: "independent" }]);
    const challenges = computeConfidence([{ evidenceType: "challenges", strength: "moderate", independence: "independent" }]);
    // Both are pure-negative cases, so lower magnitude (challenges) means less negative -> higher confidence.
    expect(challenges.confidence!).toBeGreaterThan(contradicts.confidence!);
  });

  it("clamps confidence within [0.05, 0.95]", () => {
    const many = Array.from({ length: 50 }, () => ({
      evidenceType: "supports" as const,
      strength: "strong" as const,
      independence: "independent" as const,
    }));
    const result = computeConfidence(many);
    expect(result.confidence!).toBeLessThanOrEqual(0.95);

    const manyAgainst = Array.from({ length: 50 }, () => ({
      evidenceType: "contradicts" as const,
      strength: "strong" as const,
      independence: "independent" as const,
    }));
    const resultAgainst = computeConfidence(manyAgainst);
    expect(resultAgainst.confidence!).toBeGreaterThanOrEqual(0.05);
  });

  it("rounds confidence to 3 decimals", () => {
    const result = computeConfidence([{ evidenceType: "supports", strength: "moderate", independence: "unknown" }]);
    expect(result.confidence).toBe(Math.round(result.confidence! * 1000) / 1000);
  });
});
