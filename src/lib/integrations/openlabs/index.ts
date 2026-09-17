/**
 * OpenLabs integration — documented stub.
 *
 * OpenLabs is the (future) platform where LENS publishes posts/replies and
 * reads back comments on them. Not configured yet. To wire it up:
 *   1. Add `OPENLABS_API_URL` and `OPENLABS_API_KEY` to the env schema in
 *      `src/lib/env.ts`.
 *   2. Implement `OpenLabsPublisher.publish()` against the OpenLabs API,
 *      mapping its response into `PublishResult` (externalId/externalUrl).
 *   3. Implement `OpenLabsCommentSource.listComments()` to fetch comments for
 *      a published post by external id, mapping them into `ExternalComment[]`.
 *   4. Flip `isEnabled()` on both classes to check the new env vars.
 *
 * See `src/lib/integrations/types.ts` for the `Publisher` / `CommentSource`
 * contracts these implement.
 */
import type { CommentSource, ExternalComment, Publisher, PublishableDraft, PublishResult } from "@/lib/integrations/types";

export class OpenLabsPublisher implements Publisher {
  readonly id = "openlabs";

  isEnabled(): boolean {
    return false;
  }

  async publish(_draft: PublishableDraft): Promise<PublishResult> {
    throw new Error("OpenLabs integration not configured");
  }
}

export class OpenLabsCommentSource implements CommentSource {
  readonly id = "openlabs";

  isEnabled(): boolean {
    return false;
  }

  async listComments(_postExternalId: string): Promise<ExternalComment[]> {
    throw new Error("OpenLabs integration not configured");
  }
}
