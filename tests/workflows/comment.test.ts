import { describe, expect, it } from "vitest";
import { listComments, getComment } from "@/lib/repo/comments";
import { createPost } from "@/lib/repo/posts";
import { listReplies } from "@/lib/repo/replies";
import { getTask } from "@/lib/repo/tasks";
import { ingestComment, runTask } from "@/lib/workflows/tasks";
import { makeDeps, ScriptedProvider } from "../helpers/agent";
import { useTestDb } from "../helpers/db";

function classification(type: string, extra: Record<string, unknown> = {}) {
  return () => ({
    type,
    summary: `A ${type}`,
    needsResearch: false,
    researchQuery: null,
    citedUrls: [],
    newDirection: null,
    ...extra,
  });
}

const reply = () => ({ body: "Good question. The evidence remains unresolved [1] [4].", rationale: "Answer honestly.", knowledgeChanged: false });

async function publishedPost() {
  return createPost({ title: "Cyclic OSK update", body: "Body [1]", status: "published", metadata: { nodeIds: [] } });
}

describe("comment workflow", () => {
  useTestDb();

  it("drafts a reply for a question and queues it for approval", async () => {
    const provider = new ScriptedProvider({ comment_classification: classification("question"), comment_reply: reply });
    const { deps, launched } = makeDeps(provider);
    const post = await publishedPost();
    const { comment, task } = await ingestComment(deps, { postId: post.id, author: "reader", body: "Was this replicated?" });
    expect(launched).toEqual([task.id]);

    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("awaiting_approval");
    const [r] = await listReplies();
    expect(r.status).toBe("awaiting_review");
    expect(r.commentId).toBe(comment.id);
    expect(r.metadata.classification).toBe("question");
    // no sources were retrieved, so all citation markers are stripped
    expect(r.body).not.toMatch(/\[\d\]/);
    const updated = await getComment(comment.id);
    expect(updated?.classification).toBe("question");
    expect(updated?.processedAt).not.toBeNull();
  });

  it("ends without a reply for noise", async () => {
    const provider = new ScriptedProvider({ comment_classification: classification("noise"), comment_reply: reply });
    const { deps } = makeDeps(provider);
    const post = await publishedPost();
    const { task } = await ingestComment(deps, { postId: post.id, author: "spam", body: "buy now" });
    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("completed");
    expect(await listReplies()).toHaveLength(0);
    expect(provider.calls("comment_reply")).toHaveLength(0);
    expect((await getTask(task.id))?.output?.halted).toMatch(/noise/);
    expect(await listComments({ unprocessedOnly: true })).toHaveLength(0);
  });

  it("researches cited URLs, stores knowledge with provenance, and records a new direction", async () => {
    const provider = new ScriptedProvider({
      comment_classification: classification("new_direction", {
        citedUrls: ["https://example.com/study"],
        newDirection: "Does partial reprogramming affect immune cell identity?",
      }),
      source_extraction: () => ({
        relevant: true,
        relevanceNote: "",
        studyContext: { organism: "mouse", system: null, intervention: null, design: null, sampleSize: null },
        findings: [
          {
            kind: "observation",
            statement: "Treated aged mice showed improved glucose tolerance versus controls.",
            quote: "Treated mice showed improved glucose tolerance compared with controls.",
            strength: "weak",
            tags: [],
          },
        ],
        openQuestions: [],
      }),
      knowledge_decisions: () => ({ decisions: [{ index: 0, action: "create", targetId: null, evidenceType: "supports", rationale: "" }] }),
      comment_reply: reply,
    });
    const { deps } = makeDeps(provider);
    const post = await publishedPost();
    const { task } = await ingestComment(deps, { postId: post.id, author: "scientist", body: "See https://example.com/study" });
    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("awaiting_approval");

    const observations = await deps.knowledge.listNodes({ types: ["observation"] });
    expect(observations).toHaveLength(1);
    const questions = await deps.knowledge.listNodes({ types: ["question"] });
    expect(questions.map((q) => q.statement)).toContain("Does partial reprogramming affect immune cell identity?");
    const sources = await deps.knowledge.listSources({});
    expect(sources.map((s) => s.sourceType).sort()).toEqual(["comment", "web_page"]);
    // The comment text itself never becomes evidence.
    const evidence = await deps.knowledge.listEvidence({});
    expect(evidence.every((e) => e.source.sourceType !== "comment")).toBe(true);
  });
});
