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
    expect(settings.map((s) => s.key)).toEqual([
      "chat_agent",
      "comment_agent",
      "limits",
      "models",
      "openlabs",
      "project",
      "research_agent",
      "schedule",
    ]);
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

  it("finds each node's own neighbours via match_neighbour_nodes", async () => {
    const osk = `[${fakeEmbedding("OSK expression teratoma risk").join(",")}]`;
    const oskNear = `[${fakeEmbedding("OSK expression teratoma risk in mice").join(",")}]`;
    const clock = `[${fakeEmbedding("epigenetic clock measurement").join(",")}]`;
    const rows = await t.sql<{ id: string }[]>`insert into knowledge_nodes (type, statement, origin, embedding) values
      ('claim', 'osk', 'source_derived', ${osk}::vector),
      ('claim', 'osk-near', 'source_derived', ${oskNear}::vector),
      ('claim', 'clock', 'source_derived', ${clock}::vector)
      returning id`;
    const ids = rows.map((r) => r.id);

    const near = await t.sql`
      select s.statement as node, n.statement as neighbour, m.similarity
      from match_neighbour_nodes(${ids}::uuid[], 8, 0) m
      join knowledge_nodes s on s.id = m.node_id
      join knowledge_nodes n on n.id = m.neighbour_id
      order by m.similarity desc`;

    // Every node is measured against its OWN embedding, and never against itself.
    expect(near.every((r) => r.node !== r.neighbour)).toBe(true);
    expect(near[0].node).toBe(near[0].neighbour === "osk" ? "osk-near" : "osk");
    expect([near[0].node, near[0].neighbour].sort()).toEqual(["osk", "osk-near"]);
  });

  it("excludes settled nodes from match_neighbour_nodes and honours min_similarity", async () => {
    const a = `[${fakeEmbedding("OSK expression teratoma risk").join(",")}]`;
    const b = `[${fakeEmbedding("OSK expression teratoma risk in mice").join(",")}]`;
    const rows = await t.sql<{ id: string }[]>`insert into knowledge_nodes (type, statement, origin, status, embedding) values
      ('claim', 'live', 'source_derived', 'contested', ${a}::vector),
      ('claim', 'settled', 'source_derived', 'superseded', ${b}::vector)
      returning id`;
    const live = [rows[0].id];

    // 'settled' is superseded, so it has no headroom and is not offered as a
    // neighbour — leaving 'live' with none, despite the two being near-identical.
    const all = await t.sql`select * from match_neighbour_nodes(${live}::uuid[], 8, 0)`;
    expect(all).toHaveLength(0);

    // The floor applies to real candidates: drop the exclusion by making the
    // other node live again, then price it out with an unreachable floor.
    await t.sql`update knowledge_nodes set status = 'contested' where statement = 'settled'`;
    expect(await t.sql`select * from match_neighbour_nodes(${live}::uuid[], 8, 0)`).toHaveLength(1);
    expect(await t.sql`select * from match_neighbour_nodes(${live}::uuid[], 8, 0.999)`).toHaveLength(0);
  });
});
