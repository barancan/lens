import type { DraftStatus } from "@/lib/types";

/**
 * Human-approval lifecycle shared by posts and replies. Pure; no I/O.
 *
 *   draft ──submit──▶ awaiting_review ──approve──▶ approved ──publish──▶ published
 *                          │  ▲ edit (stays)
 *                          ▼  │
 *                       rejected ──regenerate──▶ awaiting_review
 *
 * Nothing reaches `published` without passing through an explicit operator approval.
 */
export type DraftAction = "submit" | "approve" | "reject" | "edit" | "regenerate" | "publish";

const TRANSITIONS: Record<DraftAction, Partial<Record<DraftStatus, DraftStatus>>> = {
  submit: { draft: "awaiting_review" },
  approve: { awaiting_review: "approved" },
  reject: { awaiting_review: "rejected", approved: "rejected" },
  edit: { draft: "draft", awaiting_review: "awaiting_review", rejected: "awaiting_review" },
  regenerate: { awaiting_review: "awaiting_review", rejected: "awaiting_review", draft: "awaiting_review" },
  publish: { approved: "published" },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly action: DraftAction,
    readonly from: DraftStatus,
  ) {
    super(`Cannot ${action} a draft in status "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

export function nextStatus(from: DraftStatus, action: DraftAction): DraftStatus {
  const to = TRANSITIONS[action][from];
  if (!to) throw new InvalidTransitionError(action, from);
  return to;
}

export function canTransition(from: DraftStatus, action: DraftAction): boolean {
  return TRANSITIONS[action][from] !== undefined;
}

export function availableActions(from: DraftStatus): DraftAction[] {
  return (Object.keys(TRANSITIONS) as DraftAction[]).filter((a) => a !== "submit" && canTransition(from, a));
}
