import { describe, expect, it } from "vitest";
import { buildSeedSql } from "../../scripts/seed";
import { fakeEmbedding, useTestDb } from "../helpers/db";

describe("schema & seed", () => {
  const t = useTestDb();

  it("applies seed idempotently and seeds themes as open operator questions", async () => {
    await t.sql.unsafe(buildSeedSql());
    await t.sql.unsafe(buildSeedSql());
    const nodes = await t.sql`select type, status, origin from knowledge_nodes`;
    expect(nodes).toHaveLength(12);
    expect(nodes.every((n) => n.type === "question" && n.status === "open" && n.origin === "operator")).toBe(true);
    const settings = await t.sql`select key from agent_settings order by key`;
    expect(settings.map((s) => s.key)).toEqual(["chat_agent", "comment_agent", "limits", "models", "project", "research_agent"]);
  });

  it("rejects insights that are not agent-generated", async () => {
    await expect(
      t.sql`insert into knowledge_nodes (type, statement, origin) values ('insight', 'x', 'source_derived')`,
    ).rejects.toThrow(/insight_is_agent_generated/);
  });

  it("supports vector matching via match_knowledge_nodes", async () => {
    const e1 = `[${fakeEmbedding("OSK expression teratoma risk").join(",")}]`;
    const e2 = `[${fakeEmbedding("epigenetic clock measurement").join(",")}]`;
    await t.sql`insert into knowledge_nodes (type, statement, origin, embedding) values
      ('claim', 'a', 'source_derived', ${e1}::vector), ('claim', 'b', 'source_derived', ${e2}::vector)`;
    const q = `[${fakeEmbedding("teratoma risk with OSK").join(",")}]`;
    const rows = await t.sql`select n.statement from match_knowledge_nodes(${q}::vector, 2, null, null, null) m join knowledge_nodes n on n.id = m.id`;
    expect(rows[0].statement).toBe("a");
  });
});
