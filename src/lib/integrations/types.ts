/**
 * Contracts for external communication platforms (e.g. OpenLabs).
 * Workflows depend on these interfaces, never on a specific platform.
 */

export interface PublishableDraft {
  kind: "post" | "reply";
  id: string;
  title?: string;
  body: string;
  /** For replies: the platform id of the post/comment being replied to. */
  parentExternalId?: string | null;
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

export interface ExternalComment {
  externalId: string;
  author: string;
  body: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CommentSource {
  readonly id: string;
  isEnabled(): boolean;
  /** Fetch comments on one of our published posts (by its external id). */
  listComments(postExternalId: string): Promise<ExternalComment[]>;
}
