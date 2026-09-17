/**
 * OpenLabs publisher (posts + replies). `isEnabled()` is env-only — it must
 * never read settings or touch the database (`getSettings` goes through
 * `db()`, which throws when `setDb` was never called, so a DB-reading
 * adapter could not be unit-tested with stubbed fetch alone). Hints (topic,
 * type, tags) are resolved by the caller (`approvals/service.ts`) from
 * settings and passed in on the draft.
 */
import { createOpenLabsComment, createOpenLabsPost } from "./client";
import { isOpenLabsConfigured, openLabsPostUrl } from "./config";
import { OpenLabsError } from "./errors";
import { DEFAULT_TOPIC, OPENLABS_TOPICS, sanitizeTags, type OpenLabsTopic } from "./taxonomy";
import type { Publisher, PublishableDraft, PublishResult } from "@/lib/integrations/types";

function isOpenLabsTopic(value: string): value is OpenLabsTopic {
  return (OPENLABS_TOPICS as readonly string[]).includes(value);
}

/**
 * Wraps a CREATE call (post/comment) so an abort/timeout — the one case
 * where the platform may have accepted the write but we never saw the
 * response — is rethrown with an operator-facing message instead of a
 * generic abort error. This ambiguity is the one hole the idempotency
 * design (claim + rollback in `approvals/service.ts`) cannot close
 * automatically; the operator backfill (`linkExternalPostAction`) is the fix.
 */
async function createOrExplainTimeout<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpenLabsError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenLabsError(
        `Timed out waiting for OpenLabs to confirm the ${what}. Check OpenLabs before retrying — a ${what} may already exist.`,
      );
    }
    throw err;
  }
}

export class OpenLabsPublisher implements Publisher {
  readonly id = "openlabs";

  isEnabled(): boolean {
    return isOpenLabsConfigured();
  }

  async publish(draft: PublishableDraft): Promise<PublishResult> {
    if (draft.kind === "post") {
      return this.publishPost(draft);
    }
    return this.publishReply(draft);
  }

  private async publishPost(draft: PublishableDraft): Promise<PublishResult> {
    const title = draft.title?.trim();
    if (!title) {
      throw new OpenLabsError("Cannot publish a post to OpenLabs without a title");
    }

    const topic = draft.hints?.topic ?? DEFAULT_TOPIC;
    if (!isOpenLabsTopic(topic)) {
      throw new OpenLabsError(`Unknown OpenLabs topic "${topic}"`);
    }

    const type = draft.hints?.type ?? "discussion";
    const tags = sanitizeTags(draft.hints?.tags);

    const post = await createOrExplainTimeout("post", () =>
      createOpenLabsPost({ type, title, body: draft.body, topic, tags }),
    );
    if (!post.id) {
      throw new OpenLabsError("OpenLabs did not return an id for the created post");
    }
    return { externalId: post.id, externalUrl: openLabsPostUrl(post.id) };
  }

  private async publishReply(draft: PublishableDraft): Promise<PublishResult> {
    const threadExternalId = draft.threadExternalId;
    if (!threadExternalId) {
      throw new OpenLabsError(
        "Cannot publish this reply: its post was never linked to OpenLabs (no threadExternalId). " +
          "Use the operator backfill action to link the post's external id, then retry.",
      );
    }

    // A non-null parent_id that the platform rejects (4xx) is not retried flat
    // here — a mis-threaded reply is visible to humans, so the error just
    // surfaces to the operator instead of being silently "fixed".
    const parentId = draft.parentExternalId ?? null;
    const comment = await createOrExplainTimeout("comment", () =>
      createOpenLabsComment(threadExternalId, { body: draft.body, parent_id: parentId }),
    );
    if (!comment.id) {
      throw new OpenLabsError("OpenLabs did not return an id for the created comment");
    }
    return { externalId: comment.id, externalUrl: openLabsPostUrl(threadExternalId) };
  }
}
