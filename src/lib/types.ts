/**
 * Domain types shared across the app. Rows are mapped to these shapes in
 * `src/lib/repo/*`; nothing outside the repo layer sees raw SQL rows.
 * Dates are ISO strings (timestamps) or YYYY-MM-DD (publication dates).
 */

export const SOURCE_TYPES = ["paper", "preprint", "web_page", "post", "comment", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const NODE_TYPES = ["claim", "observation", "insight", "question", "hypothesis"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_STATUSES = ["open", "supported", "contested", "weak", "unresolved", "superseded", "answered"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const NODE_ORIGINS = ["source_derived", "agent_generated", "operator"] as const;
export type NodeOrigin = (typeof NODE_ORIGINS)[number];

export const EVIDENCE_TYPES = ["supports", "contradicts", "contextualizes", "replicates", "challenges"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
/** Evidence types that count "for" / "against" a claim. */
export const EVIDENCE_FOR: readonly EvidenceType[] = ["supports", "replicates"];
export const EVIDENCE_AGAINST: readonly EvidenceType[] = ["contradicts", "challenges"];

export const EVIDENCE_STRENGTHS = ["weak", "moderate", "strong"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const INDEPENDENCE = ["independent", "same_group", "unknown"] as const;
export type Independence = (typeof INDEPENDENCE)[number];

export const RELATIONSHIP_TYPES = [
  "supports",
  "contradicts",
  "derived_from",
  "raises",
  "depends_on",
  "related_to",
  "refines",
  "supersedes",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export interface Source {
  id: string;
  sourceType: SourceType;
  title: string;
  url: string | null;
  doi: string | null;
  authors: string[];
  publicationDate: string | null;
  retrievedAt: string;
  fullText: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SourceChunk {
  id: string;
  sourceId: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeNode {
  id: string;
  type: NodeType;
  statement: string;
  summary: string | null;
  confidence: number | null;
  status: NodeStatus;
  origin: NodeOrigin;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NodeHistoryEntry {
  id: string;
  nodeId: string;
  confidence: number | null;
  status: NodeStatus;
  reason: string;
  runId: string | null;
  createdAt: string;
}

export interface Evidence {
  id: string;
  claimId: string;
  sourceId: string;
  sourceChunkId: string | null;
  quote: string;
  evidenceType: EvidenceType;
  strength: EvidenceStrength;
  independence: Independence;
  notes: string | null;
  runId: string | null;
  createdAt: string;
}

/** Evidence joined with minimal source provenance for display / prompts. */
export interface EvidenceWithSource extends Evidence {
  source: Pick<Source, "id" | "title" | "url" | "doi" | "sourceType" | "publicationDate" | "authors">;
}

export interface KnowledgeEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationshipType: RelationshipType;
  confidence: number | null;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Tasks & runs
// ---------------------------------------------------------------------------
export const TASK_TYPES = ["research", "comment_reply", "regenerate_draft"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_STATUSES = ["queued", "running", "awaiting_approval", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskOrigin = "user" | "schedule" | "chat" | "system";

export interface Task {
  id: string;
  type: TaskType;
  objective: string;
  status: TaskStatus;
  origin: TaskOrigin;
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  parentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type RunStatus = "running" | "succeeded" | "failed";

export interface RunStepLog {
  name: string;
  status: "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  summary?: string;
  output?: unknown;
  error?: string;
}

export interface ToolCallLog {
  tool: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  at: string;
}

export interface LLMCallLog {
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  at: string;
  error?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRun {
  id: string;
  workflow: string;
  provider: string | null;
  model: string | null;
  taskId: string | null;
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  steps: RunStepLog[];
  toolCalls: ToolCallLog[];
  llmCalls: LLMCallLog[];
  usage: Usage;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Posts, comments, replies
// ---------------------------------------------------------------------------
export const DRAFT_STATUSES = ["draft", "awaiting_review", "approved", "rejected", "published"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface DraftRevision {
  at: string;
  by: "agent" | "operator";
  title?: string;
  body: string;
  note?: string;
}

/** Metadata attached to every agent draft so the operator can review it. */
export interface DraftMetadata {
  rationale?: string;
  sourceIds?: string[];
  nodeIds?: string[];
  provider?: string;
  model?: string;
  revisions?: DraftRevision[];
  rejectionReason?: string;
  [key: string]: unknown;
}

export interface Post {
  id: string;
  title: string;
  body: string;
  status: DraftStatus;
  taskId: string | null;
  runId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  metadata: DraftMetadata;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  publishedAt: string | null;
}

export const COMMENT_CLASSIFICATIONS = [
  "question",
  "criticism",
  "supporting_evidence",
  "contradictory_evidence",
  "new_direction",
  "noise",
] as const;
export type CommentClassification = (typeof COMMENT_CLASSIFICATIONS)[number];

export interface Comment {
  id: string;
  postId: string;
  externalId: string | null;
  author: string;
  body: string;
  classification: CommentClassification | null;
  processedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Reply {
  id: string;
  commentId: string;
  postId: string;
  body: string;
  status: DraftStatus;
  taskId: string | null;
  runId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  metadata: DraftMetadata;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  publishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCallLog[];
  runId: string | null;
  createdAt: string;
}
