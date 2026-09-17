import { OpenLabsPublisher } from "@/lib/integrations/openlabs";
import type { Publisher } from "@/lib/integrations/types";

/**
 * MVP publisher: publishing is performed by the operator outside LENS; this
 * simply records that the approved draft is now public.
 */
export class ManualPublisher implements Publisher {
  readonly id = "manual";
  isEnabled() {
    return true;
  }
  async publish() {
    return { externalId: null, externalUrl: null };
  }
}

/** The first enabled platform publisher, falling back to manual. */
export function getPublisher(): Publisher {
  const candidates: Publisher[] = [new OpenLabsPublisher()];
  return candidates.find((p) => p.isEnabled()) ?? new ManualPublisher();
}
