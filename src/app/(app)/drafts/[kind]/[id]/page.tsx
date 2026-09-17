import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionPanel, type OpenLabsPublishDefaults, type OpenLabsPublishSuggestion, type ReplyPublishPreflight } from "./action-panel";
import { AddCommentForm } from "./add-comment-form";
import { LinkExternalPostForm } from "./link-external-post-form";
import {
  EmptyState,
  NodeStatusBadge,
  NodeTypeBadge,
  PageHeader,
  Section,
  StatusBadge,
  formatConfidence,
  formatDate,
} from "@/components/common";
import { availableActions } from "@/lib/approvals/lifecycle";
import { DraftNotFoundError, getDraft } from "@/lib/approvals/service";
import { isOpenLabsConfigured } from "@/lib/integrations/openlabs";
import type { PostReception } from "@/lib/integrations/types";
import { getComment, listComments } from "@/lib/repo/comments";
import { getPost } from "@/lib/repo/posts";
import { listReplies } from "@/lib/repo/replies";
import { getSettings } from "@/lib/settings/service";
import type { DraftMetadata } from "@/lib/types";
import { getKnowledgeService } from "@/lib/workflows/runtime";

/** Reply-specific fields the comment-reply workflow stows in `metadata` alongside the shared `DraftMetadata`. */
interface ReplyDraftMetadata extends DraftMetadata {
  classification?: string;
  commentSummary?: string;
}

export default async function DraftDetailPage(props: PageProps<"/drafts/[kind]/[id]">) {
  const { kind, id } = await props.params;
  if (kind !== "post" && kind !== "reply") notFound();

  const draft = await getDraft(kind, id).catch((err) => {
    if (err instanceof DraftNotFoundError) return null;
    throw err;
  });
  if (!draft) notFound();

  const k = getKnowledgeService();
  const metadata = draft.metadata;

  const [sources, nodes] = await Promise.all([
    Promise.all((metadata.sourceIds ?? []).map((sid) => k.getSource(sid))),
    Promise.all((metadata.nodeIds ?? []).slice(0, 10).map((nid) => k.getNode(nid))),
  ]);

  let comment: Awaited<ReturnType<typeof getComment>> = null;
  let parentPost: Awaited<ReturnType<typeof getPost>> = null;
  if (draft.kind === "reply") {
    [comment, parentPost] = await Promise.all([getComment(draft.commentId), getPost(draft.postId)]);
  }

  let postComments: { id: string; author: string; body: string; classification: string | null; processedAt: string | null; replies: { id: string; status: string }[] }[] = [];
  if (draft.kind === "post" && draft.status === "published") {
    const comments = await listComments({ postId: draft.id });
    postComments = await Promise.all(
      comments.map(async (c) => {
        const replies = await listReplies({ commentId: c.id });
        return {
          id: c.id,
          author: c.author,
          body: c.body,
          classification: c.classification,
          processedAt: c.processedAt,
          replies: replies.map((r) => ({ id: r.id, status: r.status })),
        };
      }),
    );
  }

  const actions = availableActions(draft.status);
  const title = draft.kind === "post" ? draft.title : `Reply to comment on “${parentPost?.title ?? "…"}”`;

  // What the client can't know on its own: whether OpenLabs is the active
  // publisher, its behavior defaults, and this draft's own suggested hints.
  const openLabsConfigured = isOpenLabsConfigured();
  const openLabsSettings = await getSettings("openlabs");
  const openLabsDefaults: OpenLabsPublishDefaults = {
    defaultPostType: openLabsSettings.defaultPostType,
    defaultTopic: openLabsSettings.defaultTopic,
    defaultTags: openLabsSettings.defaultTags,
  };
  const rawSuggestion = metadata.openlabs as OpenLabsPublishSuggestion | undefined;
  const openLabsSuggestion: OpenLabsPublishSuggestion | undefined = rawSuggestion
    ? { type: rawSuggestion.type, topic: rawSuggestion.topic, tags: rawSuggestion.tags }
    : undefined;
  const replyPreflight: ReplyPublishPreflight | undefined =
    draft.kind === "reply"
      ? {
          postExternalId: parentPost?.externalId ?? null,
          postDraftId: draft.postId,
          commentExternalId: comment?.externalId ?? null,
        }
      : undefined;

  const reception = draft.kind === "post" ? (metadata.reception as PostReception | undefined) : undefined;

  return (
    <div>
      <PageHeader
        title={title}
        description={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <StatusBadge status={draft.status} />
            <span>Created {formatDate(draft.createdAt)}</span>
            <span>Updated {formatDate(draft.updatedAt)}</span>
            {draft.approvedAt && <span>Approved {formatDate(draft.approvedAt)}</span>}
            {draft.publishedAt && <span>Published {formatDate(draft.publishedAt)}</span>}
            {metadata.provider && (
              <span>
                {metadata.provider} / {metadata.model ?? "—"}
              </span>
            )}
            {draft.taskId && <span className="font-mono text-xs">task {draft.taskId}</span>}
            {draft.runId && (
              <Link href={`/runs/${draft.runId}`} className="hover:underline">
                run {draft.runId}
              </Link>
            )}
          </div>
        }
        actions={
          <Link href="/drafts" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
            ← back to drafts
          </Link>
        }
      />

      {draft.kind === "post" && draft.status === "published" && (
        <Section title="On OpenLabs">
          {draft.externalId ? (
            <div className="flex flex-col gap-2 text-sm">
              <a
                href={draft.externalUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="w-fit hover:underline"
              >
                View the live post ↗
              </a>
              {reception ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                  <span>{reception.upvotes} upvotes</span>
                  <span>{reception.downvotes} downvotes</span>
                  <span>{reception.commentCount} comments</span>
                  <span>
                    {reception.openDecision
                      ? `Peer review open, ends ${formatDate(reception.openDecision.votingEndsAt)}`
                      : "No open peer review"}
                  </span>
                  <span>as of {formatDate(reception.fetchedAt)}</span>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  No reception snapshot yet — it appears after the next comment check.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                LENS only reads votes and peer-review state here; it never votes or reacts on OpenLabs.
              </p>
            </div>
          ) : (
            <LinkExternalPostForm postId={draft.id} />
          )}
        </Section>
      )}

      <Section title="Body">
        <div className="rounded-lg border bg-card p-4 text-sm whitespace-pre-wrap">{draft.body}</div>
      </Section>

      <Section title="Why LENS thinks this is worth posting">
        {metadata.rationale ? (
          <p className="text-sm whitespace-pre-wrap">{metadata.rationale}</p>
        ) : (
          <EmptyState>No rationale recorded.</EmptyState>
        )}
        {draft.kind === "reply" && (
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Classification: </span>
              {(metadata as ReplyDraftMetadata).classification ?? comment?.classification ?? "—"}
            </div>
            {(metadata as ReplyDraftMetadata).commentSummary && (
              <div>
                <span className="text-muted-foreground">Comment summary: </span>
                {(metadata as ReplyDraftMetadata).commentSummary}
              </div>
            )}
          </div>
        )}
      </Section>

      {draft.kind === "reply" && (
        <Section title="Original comment">
          {comment ? (
            <blockquote className="rounded-md border-l-2 border-muted-foreground/30 bg-muted/30 px-4 py-2 text-sm">
              <div className="mb-1 font-medium">{comment.author}</div>
              <p className="whitespace-pre-wrap">{comment.body}</p>
            </blockquote>
          ) : (
            <EmptyState>Comment no longer available.</EmptyState>
          )}
          {parentPost && (
            <p className="mt-2 text-sm text-muted-foreground">
              On post{" "}
              <Link href={`/drafts/post/${parentPost.id}`} className="hover:underline">
                {parentPost.title}
              </Link>
            </p>
          )}
        </Section>
      )}

      <Section title="Sources used">
        {sources.filter(Boolean).length === 0 ? (
          <EmptyState>No sources recorded.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {sources.filter(Boolean).map((s) => (
              <li key={s!.id}>
                {s!.url ? (
                  <a href={s!.url} target="_blank" rel="noreferrer" className="hover:underline">
                    {s!.title}
                  </a>
                ) : (
                  s!.title
                )}
                <span className="ml-2 text-muted-foreground">{formatDate(s!.publicationDate, false)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Relevant knowledge">
        {nodes.filter(Boolean).length === 0 ? (
          <EmptyState>No knowledge nodes recorded.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {nodes.filter(Boolean).map((n) => (
              <li key={n!.id} className="rounded-md border p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <NodeTypeBadge type={n!.type} origin={n!.origin} />
                  <NodeStatusBadge status={n!.status} />
                  <span className="text-xs text-muted-foreground">confidence {formatConfidence(n!.confidence)}</span>
                </div>
                <Link href={`/knowledge/nodes/${n!.id}`} className="text-sm hover:underline">
                  {n!.statement}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Revision history">
        {metadata.rejectionReason && (
          <p className="mb-3 text-sm">
            <span className="text-muted-foreground">Rejection reason: </span>
            {metadata.rejectionReason}
          </p>
        )}
        {!metadata.revisions || metadata.revisions.length === 0 ? (
          <EmptyState>No revisions yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {metadata.revisions.map((rev, i) => (
              <li key={i} className="rounded-md border p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span className="font-medium text-foreground">{rev.by}</span>
                  <span>{formatDate(rev.at)}</span>
                  {rev.note && <span>— {rev.note}</span>}
                </div>
                <details>
                  <summary className="cursor-pointer text-muted-foreground">previous body</summary>
                  <div className="mt-1 whitespace-pre-wrap">{rev.body}</div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Actions">
        <ActionPanel
          kind={draft.kind}
          id={draft.id}
          actions={actions}
          initialTitle={draft.kind === "post" ? draft.title : null}
          initialBody={draft.body}
          openLabsConfigured={openLabsConfigured}
          openLabsDefaults={openLabsDefaults}
          openLabsSuggestion={openLabsSuggestion}
          replyPreflight={replyPreflight}
        />
      </Section>

      {draft.kind === "post" && draft.status === "published" && (
        <Section title="Comments received">
          <div className="mb-4">
            <AddCommentForm postId={draft.id} />
          </div>
          {postComments.length === 0 ? (
            <EmptyState>No comments recorded yet.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {postComments.map((c) => (
                <li key={c.id} className="rounded-md border p-3 text-sm">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.author}</span>
                    <span className="text-xs text-muted-foreground">{c.classification ?? "unclassified"}</span>
                    <span className="text-xs text-muted-foreground">{c.processedAt ? "processed" : "pending"}</span>
                  </div>
                  <p className="mb-1 whitespace-pre-wrap">{c.body}</p>
                  {c.replies.length > 0 && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      {c.replies.map((r) => (
                        <Link key={r.id} href={`/drafts/reply/${r.id}`} className="hover:underline">
                          reply ({r.status})
                        </Link>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
