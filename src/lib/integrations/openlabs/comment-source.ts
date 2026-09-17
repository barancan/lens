/**
 * OpenLabs comment source: reads comments and reception on our published
 * posts. Read-only in v1 — this adapter never votes, reacts, or responds to
 * a peer-review decision (see `client.ts` for the two read-only endpoints
 * this wraps). `isEnabled()` is env-only and synchronous, so it must never
 * touch settings or the DB (mirrors `OpenLabsPublisher`).
 */
import type { CommentSource, ExternalComment, PostReception } from "@/lib/integrations/types";
import { getOpenLabsPost, getOpenLabsProfile, listOpenLabsComments, listOpenLabsOpenDecisions } from "./client";
import { isOpenLabsConfigured } from "./config";

export class OpenLabsCommentSource implements CommentSource {
  readonly id = "openlabs";

  private selfHandleCache: Promise<string | null> | null = null;

  isEnabled(): boolean {
    return isOpenLabsConfigured();
  }

  async listComments(postExternalId: string): Promise<ExternalComment[]> {
    const comments = await listOpenLabsComments(postExternalId);
    // The `comments` table has no parent column, so `parentExternalId` must
    // survive in metadata — the reply publisher depends on it to target the
    // right comment when it POSTs back to the platform.
    return comments.flatMap((c) => {
      if (!c.id || !c.created_at) return [];
      return [
        {
          externalId: c.id,
          author: c.author?.handle ?? "",
          body: c.body ?? "",
          createdAt: c.created_at,
          metadata: {
            platform: "openlabs",
            parentExternalId: c.parent_id ?? null,
            authorId: c.author?.id,
            authorDisplayName: c.author?.display_name,
            accountType: c.author?.account_type,
          },
        },
      ];
    });
  }

  /** Our own handle, so a poller can skip comments we authored. Memoized per instance. */
  async selfHandle(): Promise<string | null> {
    if (!this.selfHandleCache) {
      this.selfHandleCache = getOpenLabsProfile().then((profile) => profile.handle ?? null);
    }
    return this.selfHandleCache;
  }

  /** Read-only: current vote/comment counters and any open peer-review decision. */
  async getReception(postExternalId: string): Promise<PostReception> {
    const [post, decisions] = await Promise.all([
      getOpenLabsPost(postExternalId),
      listOpenLabsOpenDecisions(postExternalId),
    ]);
    const openDecision = decisions[0];
    return {
      upvotes: post.upvote_count ?? 0,
      downvotes: post.downvote_count ?? 0,
      commentCount: post.comment_count ?? 0,
      openDecision: openDecision ? { id: openDecision.id, votingEndsAt: openDecision.voting_ends_at ?? null } : null,
      fetchedAt: new Date().toISOString(),
    };
  }
}
