import { describe, expect, it } from "vitest";
import { createThread, getThread, listMessages } from "@/lib/repo/chat";
import { getRun } from "@/lib/repo/runs";
import { listTasks } from "@/lib/repo/tasks";
import { getSettings } from "@/lib/settings/service";
import { runChatTurn } from "@/lib/workflows/chat";
import { makeDeps, ScriptedProvider } from "../helpers/agent";
import { useTestDb } from "../helpers/db";

describe("chat turn", () => {
  useTestDb();

  it("answers using knowledge tools and persists the exchange", async () => {
    const provider = new ScriptedProvider({}, (req, call) => {
      if (call === 1) {
        return { toolCalls: [{ type: "tool_call", id: "t1", name: "search_knowledge", input: { query: "teratoma risk" } }] };
      }
      const last = req.messages.at(-1);
      expect(last?.role).toBe("tool");
      return { text: "Stored knowledge on teratoma risk is currently thin." };
    });
    const { deps } = makeDeps(provider);
    await deps.knowledge.createClaim({ statement: "Continuous OSKM expression causes teratomas in mice." });
    const thread = await createThread();

    const { assistant } = await runChatTurn(deps, { threadId: thread.id, message: "What do we know about teratoma risk?" });
    expect(assistant.content).toContain("thin");
    expect(assistant.toolCalls.map((c) => c.tool)).toEqual(["search_knowledge"]);
    expect(await listMessages(thread.id)).toHaveLength(2);
    expect((await getThread(thread.id))?.title).toBe("What do we know about teratoma risk?");

    const toolResult = provider.requests[1].messages.at(-1);
    expect(JSON.stringify(toolResult)).toContain("Continuous OSKM expression");
    const run = await getRun(assistant.runId!);
    expect(run?.workflow).toBe("chat");
    expect(run?.status).toBe("succeeded");
    // Only the tool specs + short brief are sent — not the knowledge base.
    expect(provider.requests[0].system).not.toContain("Continuous OSKM expression");
    expect(provider.requests[0].tools?.map((t) => t.name)).toContain("start_research");
  });

  it("launches research and records focus directives through tools", async () => {
    const provider = new ScriptedProvider({}, (_req, call) => {
      if (call === 1) {
        return {
          toolCalls: [
            { type: "tool_call", id: "a", name: "start_research", input: { objective: "Investigate functional outcomes of OSK" } },
            { type: "tool_call", id: "b", name: "add_focus_directive", input: { directive: "Prioritise functional outcomes over epigenetic clocks" } },
            { type: "tool_call", id: "c", name: "get_claim", input: { id: "not-a-uuid" } },
          ],
        };
      }
      return { text: "Queued." };
    });
    const { deps, launched } = makeDeps(provider);
    const thread = await createThread();
    const { assistant } = await runChatTurn(deps, { threadId: thread.id, message: "Stop focusing on clocks." });

    const tasks = await listTasks({ types: ["research"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].origin).toBe("chat");
    expect(launched).toEqual([tasks[0].id]);
    expect((await getSettings("project")).focusDirectives).toContain("Prioritise functional outcomes over epigenetic clocks");
    const invalid = provider.requests[1].messages.at(-1);
    expect(JSON.stringify(invalid)).toContain("Invalid input for get_claim");
    expect(assistant.content).toBe("Queued.");
  });

  it("stops after the configured number of tool rounds", async () => {
    const provider = new ScriptedProvider({}, (req) =>
      req.toolChoice === "none"
        ? { text: "Final answer." }
        : { toolCalls: [{ type: "tool_call", id: "x", name: "list_runs", input: {} }] },
    );
    const { deps } = makeDeps(provider);
    const thread = await createThread();
    const { assistant } = await runChatTurn(deps, { threadId: thread.id, message: "loop" });
    const { maxChatToolRounds } = await getSettings("limits");
    expect(provider.requests).toHaveLength(maxChatToolRounds + 1);
    expect(assistant.content).toBe("Final answer.");
  });
});
