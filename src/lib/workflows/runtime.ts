import "server-only";
import { after } from "next/server";
import { fetchUrlDocument } from "@/lib/integrations/research/url-fetch";
import { getResearchSources } from "@/lib/integrations/research/registry";
import { createKnowledgeService, type KnowledgeService } from "@/lib/knowledge/service";
import { getEmbeddingProvider, getProvider } from "@/lib/llm/registry";
import { getSettings } from "@/lib/settings/service";
import { runTask } from "./tasks";
import type { AgentDeps } from "./types";

/**
 * Production wiring of workflow dependencies. Everything else in
 * `src/lib/workflows` receives these through `AgentDeps`.
 */

let knowledgeService: KnowledgeService | null = null;

export function getKnowledgeService(): KnowledgeService {
  if (!knowledgeService) {
    knowledgeService = createKnowledgeService({
      embed: async (texts) => {
        const { embedding } = await getSettings("models");
        return getEmbeddingProvider(embedding).embed(texts);
      },
    });
  }
  return knowledgeService;
}

export function getAgentDeps(): AgentDeps {
  const deps: AgentDeps = {
    knowledge: getKnowledgeService(),
    getProvider,
    getResearchSources,
    fetchUrl: (url) => fetchUrlDocument(url),
    launchTask: (taskId) => launchInBackground(taskId, deps),
  };
  return deps;
}

/**
 * Run a task after the current response is sent. On Vercel this keeps the
 * function alive up to the route's `maxDuration`; a task that times out stays
 * resumable from its last checkpoint.
 */
export function launchInBackground(taskId: string, deps: AgentDeps = getAgentDeps(), opts: { resume?: boolean } = {}): void {
  const job = () =>
    runTask(taskId, deps, opts).catch((err) => {
      console.error(`[lens] task ${taskId} crashed`, err);
    });
  try {
    after(job);
  } catch {
    // Outside a request scope (scripts): run detached.
    void job();
  }
}
