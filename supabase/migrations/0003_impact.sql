-- ---------------------------------------------------------------------------
-- Impact: how much drilling into a finding would move OTHER findings.
--
-- Distinct from `confidence`, which is local to a node (its own evidence).
-- Impact is a property of the node's NEIGHBOURHOOD, so it is recomputed in
-- batches rather than on read, and `impact_computed_at` makes staleness visible.
-- ---------------------------------------------------------------------------
alter table knowledge_nodes
  add column impact real check (impact is null or (impact >= 0 and impact <= 1)),
  add column impact_explanation jsonb,
  add column impact_computed_at timestamptz,
  -- The operator's drill-down queue. `requested_at` set with `consumed_at` null
  -- means "target this next run". Both are kept after a run picks the request
  -- up, so the node detail can show "requested 2d ago, picked up 3h ago"
  -- instead of the flag silently vanishing.
  add column drill_down_requested_at timestamptz,
  add column drill_down_note text,
  add column drill_down_consumed_at timestamptz;

create index knowledge_nodes_impact_idx on knowledge_nodes (impact desc nulls last);
create index knowledge_nodes_drill_down_idx on knowledge_nodes (drill_down_requested_at)
  where drill_down_requested_at is not null and drill_down_consumed_at is null;

-- ---------------------------------------------------------------------------
-- Batch nearest-neighbour lookup. `match_knowledge_nodes` takes a query vector
-- and so can only answer for one node at a time; recomputing impact needs the
-- neighbours of many nodes at once, each measured against its OWN embedding.
--
-- Nodes with no headroom (superseded/answered) are excluded inside the lateral
-- so they cannot crowd live neighbours out of the `match_count` slots.
-- ---------------------------------------------------------------------------
create or replace function match_neighbour_nodes(
  node_ids uuid[],
  match_count int default 8,
  min_similarity real default 0.6
)
returns table (node_id uuid, neighbour_id uuid, similarity float)
language sql stable
as $$
  select n.id as node_id, m.id as neighbour_id, m.similarity
  from knowledge_nodes n
  cross join lateral (
    select o.id, 1 - (o.embedding <=> n.embedding) as similarity
    from knowledge_nodes o
    where o.embedding is not null
      and o.id <> n.id
      and o.status not in ('superseded', 'answered')
    order by o.embedding <=> n.embedding
    limit match_count
  ) m
  where n.id = any(node_ids)
    and n.embedding is not null
    and m.similarity >= min_similarity;
$$;
