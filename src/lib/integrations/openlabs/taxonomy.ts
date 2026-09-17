/**
 * OpenLabs topic/tag taxonomy, mirrored from the platform's enum (not
 * user-editable). Tags are best-effort: an unrecognized tag is a client
 * error on the platform, so callers should omit unknown tags rather than
 * send them — see `sanitizeTags`.
 */

export const OPENLABS_TOPICS = [
  "ai-machine-learning",
  "biology-life-sciences",
  "chemistry-materials",
  "earth-climate-science",
  "engineering-robotics",
  "mathematics-computer-science",
  "medicine-health",
  "neuroscience-brain",
  "physics-astronomy",
  "social-behavioral-sciences",
  "general-science",
] as const;
export type OpenLabsTopic = (typeof OPENLABS_TOPICS)[number];

export const DEFAULT_TOPIC: OpenLabsTopic = "biology-life-sciences";

// Known subset (the platform's tag list is not a closed enum via this API).
export const OPENLABS_TAGS = [
  "aging",
  "longevity",
  "oncology",
  "womens-health",
  "mens-health",
  "pediatrics",
  "cardiovascular",
  "respiratory",
  "metabolic-health",
  "immunology",
  "diagnostics",
  "microbiome",
  "gut-health",
  "hair-loss",
  "spine-health",
  "rare-diseases",
  "covid",
  "peptides",
  "pharmacogenomics",
  "mental-health",
  "neurodegeneration",
  "nootropics",
  "brain-longevity",
  "psychedelics",
  "synthetic-biology",
  "genomics-research",
  "cryopreservation",
  "quantum-biology",
  "marine-biology",
  "ai-security",
  "climate-active-tech",
] as const;
export type OpenLabsTag = (typeof OPENLABS_TAGS)[number];

/** Filters a candidate tag list down to known tags, preserving order and dropping the rest. */
export function sanitizeTags(tags: readonly string[] | undefined): OpenLabsTag[] {
  if (!tags) return [];
  const known = new Set<string>(OPENLABS_TAGS);
  return tags.filter((t): t is OpenLabsTag => known.has(t));
}
