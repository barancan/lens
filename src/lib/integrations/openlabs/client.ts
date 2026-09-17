/**
 * OpenLabs REST client: thin wrappers over `openLabsFetch`. Names are
 * prefixed with `OpenLabs` so they never collide with the repo's own
 * posts/comments helpers (`src/lib/repo/*`).
 * https://api.openlabs.bio.xyz/api/docs/openapi.json
 */
import { openLabsFetch } from "./http";
import { OpenLabsError } from "./errors";
import type { OpenLabsTopic } from "./taxonomy";

const MAX_TITLE_LENGTH = 500;

// Raw wire shapes, all fields optional per repo convention — these adapters
// map/validate defensively rather than trusting every field is present.
export interface OpenLabsAuthor {
  id?: string;
  handle?: string;
  display_name?: string;
  account_type?: string;
}

export interface OpenLabsTopicRef {
  slug?: string;
  name?: string;
}

export interface OpenLabsPost {
  id?: string;
  type?: "claim" | "discussion";
  title?: string;
  body?: string;
  status?: string;
  author?: OpenLabsAuthor;
  topic?: OpenLabsTopicRef;
  tags?: string[];
  created_at?: string;
  // Reception counters, read-only: LENS reads how a post is received but
  // never votes/reacts/responds to peer-review decisions (see comment-source.ts).
  upvote_count?: number;
  downvote_count?: number;
  comment_count?: number;
  reaction_count?: number;
  voting_ends_at?: string | null;
}

export interface OpenLabsDecision {
  id?: string;
  status?: string;
  voting_ends_at?: string | null;
}

export interface OpenLabsComment {
  id?: string;
  post_id?: string;
  parent_id?: string | null;
  body?: string;
  author?: OpenLabsAuthor;
  created_at?: string;
}

export interface OpenLabsProfile {
  id?: string;
  handle?: string;
  display_name?: string;
  description?: string;
}

/** Validated locally before POSTing, so an invalid post never burns a rate-limited request. */
export async function createOpenLabsPost(input: {
  type: "claim" | "discussion";
  title: string;
  body: string;
  topic: OpenLabsTopic;
  tags?: string[];
}): Promise<OpenLabsPost> {
  const endpoint = "/api/v1/posts";
  if (!input.title || input.title.length > MAX_TITLE_LENGTH) {
    throw new OpenLabsError(`Post title must be 1-${MAX_TITLE_LENGTH} characters`, { endpoint });
  }
  if (!input.body) {
    throw new OpenLabsError("Post body must not be empty", { endpoint });
  }
  return openLabsFetch<OpenLabsPost>(endpoint, { method: "POST", body: input });
}

/** Validated locally before POSTing, so an invalid comment never burns a rate-limited request. */
export async function createOpenLabsComment(
  postId: string,
  input: { body: string; parent_id: string | null },
): Promise<OpenLabsComment> {
  const endpoint = `/api/v1/posts/${encodeURIComponent(postId)}/comments`;
  if (!input.body) {
    throw new OpenLabsError("Comment body must not be empty", { endpoint });
  }
  return openLabsFetch<OpenLabsComment>(endpoint, { method: "POST", body: input });
}

export function listOpenLabsComments(postId: string): Promise<OpenLabsComment[]> {
  return openLabsFetch<OpenLabsComment[]>(`/api/v1/posts/${encodeURIComponent(postId)}/comments`);
}

export function getOpenLabsProfile(): Promise<OpenLabsProfile> {
  return openLabsFetch<OpenLabsProfile>("/api/v1/profiles/me");
}

export function updateOpenLabsProfile(patch: { display_name?: string; description?: string }): Promise<OpenLabsProfile> {
  return openLabsFetch<OpenLabsProfile>("/api/v1/profiles/me", { method: "PUT", body: patch });
}

/** Read-only reception: current vote/comment counters and voting deadline for one of our posts. */
export function getOpenLabsPost(postId: string): Promise<OpenLabsPost> {
  return openLabsFetch<OpenLabsPost>(`/api/v1/posts/${encodeURIComponent(postId)}`);
}

/**
 * Open peer-review decisions on one of our posts. Read-only, like
 * `getOpenLabsPost` above — LENS never responds to a decision (no
 * `PUT /decisions/{id}/respond`; that is explicitly deferred).
 */
export async function listOpenLabsOpenDecisions(
  postId: string,
): Promise<{ id: string; status?: string; voting_ends_at?: string | null }[]> {
  const url = new URL("/api/v1/decisions", "http://openlabs.internal");
  url.searchParams.set("post_id", postId);
  url.searchParams.set("status", "open");
  const path = `${url.pathname}${url.search}`;
  const data = await openLabsFetch<{ data?: OpenLabsDecision[] }>(path);
  return (data.data ?? []).flatMap((d) => (d.id ? [{ id: d.id, status: d.status, voting_ends_at: d.voting_ends_at }] : []));
}
