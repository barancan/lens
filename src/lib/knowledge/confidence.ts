import type { Evidence, NodeStatus } from "@/lib/types";

/**
 * Rolls a claim/observation/hypothesis's evidence up into a confidence
 * number and status.
 *
 * This is a transparent, inspectable HEURISTIC, not a calibrated
 * probability or a statistical inference. It exists so an operator can see
 * exactly why a number moved (which evidence, what weight) rather than
 * trusting an opaque model. Treat the output as "how the recorded evidence
 * leans", not "the chance this is true".
 */

export type ConfidenceEvidenceInput = Pick<Evidence, "evidenceType" | "strength" | "independence">;

export interface ConfidenceResult {
  confidence: number | null;
  status: NodeStatus;
}

const STRENGTH_WEIGHT: Record<Evidence["strength"], number> = {
  weak: 0.5,
  moderate: 1,
  strong: 1.5,
};

const INDEPENDENCE_MULTIPLIER: Record<Evidence["independence"], number> = {
  independent: 1,
  same_group: 0.6,
  unknown: 0.8,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeConfidence(evidence: readonly ConfidenceEvidenceInput[]): ConfidenceResult {
  let positive = 0;
  let negative = 0;

  for (const item of evidence) {
    const magnitude = STRENGTH_WEIGHT[item.strength] * INDEPENDENCE_MULTIPLIER[item.independence];
    switch (item.evidenceType) {
      case "supports":
        positive += magnitude;
        break;
      case "replicates":
        positive += magnitude * 1.2;
        break;
      case "contradicts":
        negative += magnitude;
        break;
      case "challenges":
        negative += magnitude * 0.7;
        break;
      case "contextualizes":
        // Contextual evidence neither supports nor undermines the claim.
        break;
    }
  }

  if (positive === 0 && negative === 0) {
    return { confidence: null, status: "unresolved" };
  }

  const raw = 0.5 + 0.5 * ((positive - negative) / (positive + negative + 1));
  const confidence = Math.round(clamp(raw, 0.05, 0.95) * 1000) / 1000;

  const bothPresent = positive > 0 && negative > 0;
  const ratio = bothPresent ? Math.min(positive, negative) / Math.max(positive, negative) : 0;

  let status: NodeStatus;
  if (bothPresent && ratio >= 0.34) {
    status = "contested";
  } else if (confidence >= 0.65) {
    status = "supported";
  } else if (confidence <= 0.35) {
    status = "weak";
  } else {
    status = "unresolved";
  }

  return { confidence, status };
}
