/**
 * Pull comments on our published posts into LENS so the existing
 * comment-reply workflow can draft responses, and refresh how each post is
 * being received. Called by the comments cron route and (Wave 3) an
 * on-demand operator button — both share this one entry point.
 *
 * Self-filtering is the single most important correctness property here: if
 * we ever ingested our own comments we would draft replies to ourselves,
 * which would be visible to the public on the platform. See the
 * `selfHandle()` handling below.
 */
import { getCommentSource } from "@/lib/approvals/comment-source";
import type { CommentSource, ExternalComment } from "@/lib/integrations/types";
import { findCommentByExternalId } from "@/lib/repo/comments";
import { listPosts, updatePost } from "@/lib/repo/posts";
import { findReplyByExternalId } from "@/lib/repo/replies";
import { getSettings } from "@/lib/settings/service";
import { ingestComment } from "@/lib/workflows/tasks";
import type { AgentDeps } from "@/lib/workflows/types";

export interface PollResult {
  postsChecked: number;
  commentsSeen: number;
  ingested: number;
  skipped: number;
  errors: { postId: string; error: string }[];
}

function zeroResult(): PollResult {
  return { postsChecked: 0, commentsSeen: 0, ingested: 0, skipped: 0, errors: [] };
}

/** Postgres unique_violation — a concurrent cron run and button click can race on `(post_id, external_id)`. */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "23505");
}

export async function pollExternalComments(
  deps: AgentDeps,
  opts: { source?: CommentSource; maxPosts?: number; maxIngests?: number } = {},
): Promise<PollResult> {
  const source = opts.source ?? getCommentSource();
  if (!source || !source.isEnabled()) return zeroResult();

  const settings = await getSettings("openlabs");
  if (settings.pollComments === false) return zeroResult();

  const maxPosts = opts.maxPosts ?? settings.maxPostsPerPoll;
  const maxIngests = opts.maxIngests ?? settings.maxIngestsPerPoll;

  // A failing selfHandle() must abort the whole poll rather than proceed
  // blind: without it we cannot tell our own comments apart from real ones.
  let selfHandle: string | null = null;
  try {
    selfHandle = (await source.selfHandle?.()) ?? null;
  } catch (err) {
    throw new Error(`OpenLabs self-handle lookup failed, aborting comment poll: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const result = zeroResult();
  const posts = await listPosts({ statuses: ["published"], withExternalId: true, limit: maxPosts });

  for (const post of posts) {
    if (!post.externalId) continue;
    result.postsChecked += 1;

    let comments: ExternalComment[];
    try {
      comments = await source.listComments(post.externalId);
    } catch (err) {
      result.errors.push({ postId: post.id, error: (err as Error).message });
      continue;
    }

    for (const comment of comments) {
      result.commentsSeen += 1;

      if (selfHandle && comment.author === selfHandle) {
        result.skipped += 1;
        continue;
      }
      if (await findCommentByExternalId(post.id, comment.externalId)) {
        result.skipped += 1;
        continue;
      }
      if (await findReplyByExternalId(comment.externalId)) {
        result.skipped += 1;
        continue;
      }

      if (result.ingested >= maxIngests) {
        // Stop ingesting; nothing was stored for the remainder so the next
        // run picks it up. Each ingest launches an LLM workflow, so this cap
        // is the throttle that stops a busy thread from starting dozens of runs.
        result.skipped += 1;
        continue;
      }

      try {
        await ingestComment(deps, {
          postId: post.id,
          author: comment.author,
          body: comment.body,
          externalId: comment.externalId,
          metadata: comment.metadata,
        });
        result.ingested += 1;
      } catch (err) {
        if (isUniqueViolation(err)) {
          result.skipped += 1;
          continue;
        }
        result.errors.push({ postId: post.id, error: (err as Error).message });
      }
    }

    // Reception is a nice-to-have snapshot, never a blocker: a failure here
    // must not stop ingestion above.
    try {
      const reception = await source.getReception?.(post.externalId);
      if (reception) {
        await updatePost(post.id, { metadata: { ...post.metadata, reception } });
      }
    } catch {
      // non-fatal
    }
  }

  return result;
}
