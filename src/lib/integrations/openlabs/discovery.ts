import type { DiscoveredItem, DiscoveryQuery, DiscoverySource } from "@/lib/integrations/types";
import { listOpenLabsPosts, listOpenLabsProjects, type OpenLabsPost, type OpenLabsProject } from "./client";
import { isOpenLabsConfigured, openLabsConfig } from "./config";

/** The longest word of a multi-word query, or null if there is only one term. */
export function broadestTerm(query: string): string | null {
  const terms = query
    .split(/[\s,]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((t) => t.length >= 4);
  if (terms.length < 2) return null;
  return terms.reduce((longest, t) => (t.length > longest.length ? t : longest));
}

/**
 * Reads the public OpenLabs feed so the agent can see what the community is
 * posting and building, and turn that into new research questions.
 *
 * Read-only by construction: this adapter only ever issues GETs. Nothing it
 * returns becomes evidence — see the note on `DiscoveredItem`.
 */
export class OpenLabsDiscoverySource implements DiscoverySource {
  readonly id = "openlabs";
  readonly description = "Posts, discussions and projects on OpenLabs";

  isEnabled(): boolean {
    return isOpenLabsConfigured();
  }

  async search(query: DiscoveryQuery): Promise<DiscoveredItem[]> {
    const kinds = query.kinds?.length ? query.kinds : (["post", "project"] as const);
    const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
    const items: DiscoveredItem[] = [];

    if (kinds.includes("post")) {
      // "trending" surfaces what the community is actually engaging with; the
      // search term still constrains it to our subject matter.
      const page = await this.withBroadeningRetry(query.query, (search) =>
        listOpenLabsPosts({ search, topic: query.topic, sort: "trending", limit }),
      );
      items.push(...(page.data ?? []).flatMap((p) => this.mapPost(p)));
    }

    if (kinds.includes("project")) {
      const page = await this.withBroadeningRetry(query.query, (search) =>
        listOpenLabsProjects({ search, topic: query.topic, sort: "most_active", limit }),
      );
      items.push(...(page.data ?? []).flatMap((p) => this.mapProject(p)));
    }

    return items;
  }

  /**
   * OpenLabs' `search` narrows hard as terms are added — it appears to require
   * every term, so "partial reprogramming teratoma" returns nothing even though
   * "reprogramming" alone matches ~1000 posts and "teratoma" ~44. Left alone
   * that reads as "the platform has nothing", which is badly misleading.
   *
   * So an empty multi-term result is retried exactly once with the single
   * longest term, which is a decent proxy for the most distinctive one and is
   * deterministic. Recall is what matters here: triage discards the noise, and
   * finding nothing costs the whole run.
   */
  private async withBroadeningRetry<T extends { data?: unknown[] }>(
    search: string,
    fetchPage: (search: string) => Promise<T>,
  ): Promise<T> {
    const page = await fetchPage(search);
    if ((page.data ?? []).length > 0) return page;

    const broadest = broadestTerm(search);
    if (!broadest || broadest === search) return page;
    return fetchPage(broadest);
  }

  private publicUrl(path: string): string | null {
    try {
      return `${openLabsConfig().publicBaseUrl}${path}`;
    } catch {
      // Config throws without a credential; a missing URL is not worth failing over.
      return null;
    }
  }

  /** Defensive: the wire shape has every field optional, so skip anything unusable. */
  private mapPost(post: OpenLabsPost): DiscoveredItem[] {
    if (!post.id || !post.title) return [];
    return [
      {
        sourceId: this.id,
        kind: "post",
        externalId: post.id,
        title: post.title,
        excerpt: (post.body ?? "").slice(0, 1200),
        url: this.publicUrl(`/post/${post.id}`),
        author: post.author?.handle ?? post.author?.display_name ?? null,
        topic: post.topic?.slug ?? null,
        tags: post.tags ?? [],
        createdAt: post.created_at ?? null,
        metrics: { comments: post.comment_count, upvotes: post.upvote_count },
      },
    ];
  }

  private mapProject(project: OpenLabsProject): DiscoveredItem[] {
    if (!project.id || !project.title) return [];
    return [
      {
        sourceId: this.id,
        kind: "project",
        externalId: project.id,
        title: project.title,
        excerpt: (project.summary ?? "").slice(0, 1200),
        url: this.publicUrl(`/project/${project.id}`),
        author: project.creator?.handle ?? project.creator?.display_name ?? null,
        topic: project.topic?.slug ?? null,
        tags: project.tags ?? [],
        createdAt: project.created_at ?? null,
        metrics: { comments: project.comment_count, threads: project.thread_count },
      },
    ];
  }
}
