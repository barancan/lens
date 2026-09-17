/**
 * Contracts for external communication platforms (e.g. OpenLabs).
 * Workflows depend on these interfaces, never on a specific platform.
 */

/** Platform-specific publish preferences. Ignored by publishers that don't support them. */
export interface PublishHints {
  type?: "claim" | "discussion";
  topic?: string;
  tags?: string[];
}

export interface PublishableDraft {
  kind: "post" | "reply";
  id: string;
  title?: string;
  body: string;
  /**
   * For replies: the platform id of the parent COMMENT being replied to
   * (null/undefined when replying directly to the post). Distinct from
   * `threadExternalId` below — do not conflate the two.
   */
  parentExternalId?: string | null;
  /**
   * For replies: the platform id of the POST the thread lives on. A reply
   * targets an endpoint scoped to the post (e.g. `/posts/{threadExternalId}/comments`),
   * so this must be resolved separately from `parentExternalId`, which only
   * identifies the parent comment within that thread.
   */
  threadExternalId?: string | null;
  hints?: PublishHints;
}

export interface PublishResult {
  externalId: string | null;
  externalUrl: string | null;
}

export interface Publisher {
  readonly id: string;
  isEnabled(): boolean;
  publish(draft: PublishableDraft): Promise<PublishResult>;
}

/**
 * `metadata` carries `{ platform, parentExternalId, authorId, authorDisplayName }`
 * (adapter-specific; not enforced by this type). `parentExternalId` here is again
 * the parent COMMENT's platform id, needed because the `comments` table has no
 * parent column of its own.
 */
export interface ExternalComment {
  externalId: string;
  author: string;
  body: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Read-only snapshot of how one of our posts is being received. Sources may
 * implement `getReception` (below) but must never vote, react, or respond to
 * a peer-review decision — v1 only reads platform state, never writes it.
 */
export interface PostReception {
  upvotes: number;
  downvotes: number;
  commentCount: number;
  openDecision: { id: string; votingEndsAt: string | null } | null;
  fetchedAt: string;
}

export interface CommentSource {
  readonly id: string;
  isEnabled(): boolean;
  /** Fetch comments on one of our published posts (by its external id). */
  listComments(postExternalId: string): Promise<ExternalComment[]>;
  /** Our own platform handle/id, so a poller can skip comments we authored ourselves. */
  selfHandle?(): Promise<string | null>;
  /** Optional and additive so non-OpenLabs sources (and ManualPublisher-era code) stay valid; read-only. */
  getReception?(postExternalId: string): Promise<PostReception>;
}
