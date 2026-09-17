import type { LLMMessage, TextPart, ToolCallPart, ToolResultPart } from "@/lib/llm/types";
import { addMessage, getThread, listMessages, renameThread } from "@/lib/repo/chat";
import { createRun, finishRun } from "@/lib/repo/runs";
import { getAllSettings } from "@/lib/settings/service";
import { createChatTools } from "@/lib/tools/chat-tools";
import { invokeTool, toToolSpec, type ToolResult } from "@/lib/tools/types";
import type { ChatMessage } from "@/lib/types";
import { buildRunContext } from "./engine";
import { chatSystemPrompt } from "./prompts";
import type { AgentDeps } from "./types";

/**
 * One operator chat turn: a bounded tool-use loop.
 *
 *   user message → [LLM ↔ tools] × ≤ maxChatToolRounds → assistant message
 *
 * Knowledge is retrieved through tools on demand; the prompt carries only the
 * project brief and a one-line knowledge-base summary.
 */

const HISTORY_MESSAGES = 20;
const MAX_TOOL_RESULT_CHARS = 12000;

function serializeResult(result: ToolResult): string {
  const text = JSON.stringify(result.ok ? result.data : { error: result.error });
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : text;
}

export async function runChatTurn(
  deps: AgentDeps,
  input: { threadId: string; message: string },
): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
  const thread = await getThread(input.threadId);
  if (!thread) throw new Error(`Chat thread ${input.threadId} not found`);

  const history = await listMessages(thread.id, HISTORY_MESSAGES);
  const user = await addMessage({ threadId: thread.id, role: "user", content: input.message });
  if (history.length === 0) await renameThread(thread.id, input.message.slice(0, 60));

  const settings = await getAllSettings();
  const ref = settings.models.chat;
  const run = await createRun({
    workflow: "chat",
    provider: ref.provider,
    model: ref.model,
    input: { threadId: thread.id, message: input.message },
  });
  const ctx = buildRunContext({ runId: run.id, task: null, settings, deps });
  const tools = createChatTools(ctx);
  const specs = tools.map(toToolSpec);

  const stats = await deps.knowledge.stats();
  const statsLine = `${stats.nodesByType.claim} claims, ${stats.nodesByType.observation} observations, ${stats.nodesByType.hypothesis} hypotheses, ${stats.nodesByType.insight} insights, ${stats.nodesByType.question} questions, ${stats.sources} sources, ${stats.evidence} evidence items.`;
  const system = chatSystemPrompt(settings, statsLine);

  const messages: LLMMessage[] = [
    ...history.map((m): LLMMessage => ({ role: m.role, content: m.content })),
    { role: "user", content: input.message },
  ];

  let answer = "";
  try {
    const maxRounds = settings.limits.maxChatToolRounds;
    for (let round = 0; round <= maxRounds; round++) {
      const finalRound = round === maxRounds;
      const response = await ctx.llm.generate("chat", `chat_round_${round}`, {
        system,
        messages,
        tools: specs,
        toolChoice: finalRound ? "none" : "auto",
        maxTokens: 2500,
      });
      if (response.toolCalls.length === 0 || finalRound) {
        answer = response.text;
        break;
      }
      const assistantParts: (TextPart | ToolCallPart)[] = [];
      if (response.text) assistantParts.push({ type: "text", text: response.text });
      assistantParts.push(...response.toolCalls);
      messages.push({ role: "assistant", content: assistantParts });

      const results: ToolResultPart[] = [];
      for (const call of response.toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        let result: ToolResult;
        if (!tool) {
          result = { ok: false, error: `Unknown tool ${call.name}` };
        } else {
          try {
            result = await ctx.trace(tool.name, call.input, () => invokeTool(tool, call.input, { runId: run.id, taskId: null }), (r) =>
              r.ok ? { ok: true } : { ok: false, error: r.error },
            );
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        results.push({ type: "tool_result", toolCallId: call.id, content: serializeResult(result), isError: !result.ok });
      }
      messages.push({ role: "tool", content: results });
    }
    if (!answer.trim()) answer = "(No answer was produced. See the run log for details.)";
    await finishRun(run.id, { status: "succeeded", output: { answer } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    answer = `Something went wrong while answering: ${message}`;
    await finishRun(run.id, { status: "failed", error: message });
  }

  const assistant = await addMessage({
    threadId: thread.id,
    role: "assistant",
    content: answer,
    toolCalls: ctx.toolCalls(),
    runId: run.id,
  });
  return { user, assistant };
}
