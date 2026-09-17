-- Semantic search helpers. Similarity = 1 - cosine distance.

create or replace function match_knowledge_nodes(
  query_embedding vector(1536),
  match_count int default 10,
  filter_types text[] default null,
  min_confidence real default null,
  filter_tags text[] default null
)
returns table (id uuid, similarity float)
language sql stable
as $$
  select n.id, 1 - (n.embedding <=> query_embedding) as similarity
  from knowledge_nodes n
  where n.embedding is not null
    and (filter_types is null or n.type = any(filter_types))
    and (min_confidence is null or n.confidence >= min_confidence)
    and (filter_tags is null or n.tags && filter_tags)
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_source_chunks(
  query_embedding vector(1536),
  match_count int default 10,
  filter_source_types text[] default null,
  published_after date default null,
  exclude_source_ids uuid[] default null
)
returns table (id uuid, source_id uuid, similarity float)
language sql stable
as $$
  select c.id, c.source_id, 1 - (c.embedding <=> query_embedding) as similarity
  from source_chunks c
  join sources s on s.id = c.source_id
  where c.embedding is not null
    and (filter_source_types is null or s.source_type = any(filter_source_types))
    and (published_after is null or s.publication_date >= published_after)
    and (exclude_source_ids is null or not (c.source_id = any(exclude_source_ids)))
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
