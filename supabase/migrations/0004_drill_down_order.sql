-- ---------------------------------------------------------------------------
-- Operator-controlled ordering for the drill-down queue.
--
-- Until now the queue was ordered by impact, which is derived and can change
-- under the operator's feet when a run rescores. Drag-and-drop needs an order
-- the operator owns, so position is explicit: assigned on queueing (append to
-- the end) and rewritten on reorder.
-- ---------------------------------------------------------------------------
alter table knowledge_nodes add column drill_down_position integer;

-- Existing pending requests keep the order they were shown in (impact first),
-- so nothing appears to jump when this ships.
with ranked as (
  select id, row_number() over (order by impact desc nulls last, drill_down_requested_at asc) as rn
  from knowledge_nodes
  where drill_down_requested_at is not null and drill_down_consumed_at is null
)
update knowledge_nodes n
set drill_down_position = ranked.rn
from ranked
where n.id = ranked.id;
