import { OpenLabsDiscoverySource } from "@/lib/integrations/openlabs";
import type { DiscoverySource } from "@/lib/integrations/types";

/**
 * The first enabled discovery source, or `null`. Like `getCommentSource()`
 * there is no fallback: without a platform there is nothing to discover, and
 * the workflow halts cleanly rather than inventing results. Synchronous —
 * enablement is env-only, so this never touches the DB.
 */
export function getDiscoverySource(): DiscoverySource | null {
  const candidates: DiscoverySource[] = [new OpenLabsDiscoverySource()];
  return candidates.find((s) => s.isEnabled()) ?? null;
}
