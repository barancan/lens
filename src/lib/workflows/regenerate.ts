import { z } from "zod";
import { applyRegeneratedDraft, getDraft, type DraftKind } from "@/lib/approvals/service";
import type { PublishHints } from "@/lib/integrations/types";
import { getComment } from "@/lib/repo/comments";
import { composePost, finalizeCitations, gatherMaterial } from "./knowledge-ops";
import { commentSystemPrompt } from "./prompts";
import type { BaseState, RunContext, WorkflowDefinition } from "./types";

/**
 * Operator-requested rewrite of a post or reply draft.
 * Task input: { kind: "post" | "reply", draftId, feedback }
 */

export interface RegenerateState extends BaseState {
  kind: DraftKind;
  draftId: string;
  feedback: string;
  done?: boolean;
}

const replyRewriteSchema = z.object({
  body: z.string().min(1),
  rationale: z.string(),
});

async function rewrite(state: RegenerateState, ctx: RunContext): Promise<Partial<RegenerateState>> {
  const draft = await getDraft(state.kind, state.draftId);

  if (draft.kind === "post") {
    const topic = String(draft.metadata.topic ?? draft.title);
    const material = await gatherMaterial(ctx, topic, draft.metadata.nodeIds?.slice(0, 6) ?? []);
    const written = await composePost(ctx, {
      topic,
      material,
      previous: { title: draft.title, body: draft.body },
      feedback: state.feedback,
      // A draft suggested as a claim must keep its falsification requirement
      // through a rewrite; without this the rewrite silently drops it.
      postType: (draft.metadata.openlabs as Partial<PublishHints> | undefined)?.type,
    });
    const ref = ctx.llm.modelFor("post_writer");
    await applyRegeneratedDraft(
      "post",
      draft.id,
      { title: written.title, body: written.body, rationale: written.rationale, ...ref },
      state.feedback,
    );
    return { done: true };
  }

  const comment = await getComment(draft.commentId);
  const material = await gatherMaterial(ctx, comment?.body.slice(0, 500) ?? draft.body, draft.metadata.nodeIds?.slice(0, 6) ?? []);
  const { data } = await ctx.llm.structured(
    "comment_reply",
    "rewrite_reply",
    {
      system: commentSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Rewrite this reply according to the operator feedback.

<comment author="${comment?.author ?? "unknown"}">
${comment?.body ?? "(comment unavailable)"}
</comment>

PREVIOUS REPLY:
${draft.body}

OPERATOR FEEDBACK:
${state.feedback}

KNOWLEDGE:
${material.context}

Cite with [n] using the CITABLE SOURCES numbering; do not include a source list.`,
        },
      ],
      maxTokens: 1500,
    },
    { name: "reply_rewrite", schema: replyRewriteSchema },
  );
  const cited = finalizeCitations(data.body, material.sources);
  const ref = ctx.llm.modelFor("comment_reply");
  await applyRegeneratedDraft("reply", draft.id, { body: cited.body, rationale: data.rationale, ...ref }, state.feedback);
  return { done: true };
}

export const regenerateWorkflow: WorkflowDefinition<RegenerateState> = {
  name: "regenerate_draft",
  primaryModel: "post_writer",
  initialState: (task) => ({
    kind: task.input.kind === "reply" ? "reply" : "post",
    draftId: String(task.input.draftId ?? ""),
    feedback: String(task.input.feedback ?? ""),
  }),
  steps: [{ name: "rewrite", run: rewrite, summarize: (s) => `rewrote ${s.kind} ${s.draftId}` }],
  finalStatus: () => "awaiting_approval",
  output: (s) => ({ kind: s.kind, draftId: s.draftId }),
};
