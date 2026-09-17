import { OpenLabsCommentSource } from "@/lib/integrations/openlabs";
import type { CommentSource } from "@/lib/integrations/types";

/**
 * The first enabled comment source, or `null`. Unlike `getPublisher()` there
 * is no manual fallback — a null source just means the poller no-ops, since
 * there is nothing to poll without a platform. Synchronous, like
 * `getPublisher()`: enablement is env-only so this never touches the DB.
 */
export function getCommentSource(): CommentSource | null {
  const candidates: CommentSource[] = [new OpenLabsCommentSource()];
  return candidates.find((s) => s.isEnabled()) ?? null;
}
