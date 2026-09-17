-- LENS initial schema.
-- Knowledge is stored relationally; embeddings live alongside rows (pgvector);
-- graph-like structure is expressed through knowledge_edges.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Sources & chunks
-- ---------------------------------------------------------------------------
create table sources (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('paper','preprint','web_page','post','comment','other')),
  title text not null,
  url text unique,
  doi text unique,
  authors text[] not null default '{}',
  publication_date date,
  retrieved_at timestamptz not null default now(),
  full_text text,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index sources_type_idx on sources (source_type);
create index sources_pubdate_idx on sources (publication_date);
create index sources_tags_idx on sources using gin (tags);

create table source_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}',
  unique (source_id, chunk_index)
);
create index source_chunks_embedding_idx on source_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Knowledge nodes (claims, observations, insights, questions, hypotheses)
-- ---------------------------------------------------------------------------
create table knowledge_nodes (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('claim','observation','insight','question','hypothesis')),
  statement text not null,
  summary text,
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status text not null default 'open'
    check (status in ('open','supported','contested','weak','unresolved','superseded','answered')),
  origin text not null check (origin in ('source_derived','agent_generated','operator')),
  tags text[] not null default '{}',
  embedding vector(1536),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Insights are, by definition, agent interpretations.
  constraint insight_is_agent_generated check (type <> 'insight' or origin = 'agent_generated')
);
create index knowledge_nodes_type_idx on knowledge_nodes (type, status);
create index knowledge_nodes_tags_idx on knowledge_nodes using gin (tags);
create index knowledge_nodes_embedding_idx on knowledge_nodes using hnsw (embedding vector_cosine_ops);

create table knowledge_node_history (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references knowledge_nodes(id) on delete cascade,
  confidence real,
  status text not null,
  reason text not null,
  run_id uuid,
  created_at timestamptz not null default now()
);
create index knowledge_node_history_node_idx on knowledge_node_history (node_id, created_at);

-- ---------------------------------------------------------------------------
-- Evidence: source material attached to a claim-like node. Provenance required.
-- ---------------------------------------------------------------------------
create table evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references knowledge_nodes(id) on delete cascade,
  source_id uuid not null references sources(id) on delete restrict,
  source_chunk_id uuid references source_chunks(id) on delete set null,
  quote text not null,
  evidence_type text not null check (evidence_type in ('supports','contradicts','contextualizes','replicates','challenges')),
  strength text not null default 'moderate' check (strength in ('weak','moderate','strong')),
  independence text not null default 'unknown' check (independence in ('independent','same_group','unknown')),
  notes text,
  run_id uuid,
  created_at timestamptz not null default now(),
  unique (claim_id, source_id, quote)
);
create index evidence_claim_idx on evidence (claim_id, evidence_type);
create index evidence_source_idx on evidence (source_id);

-- ---------------------------------------------------------------------------
-- Edges between knowledge nodes
-- ---------------------------------------------------------------------------
create table knowledge_edges (
  id uuid primary key default gen_random_uuid(),
  from_node_id uuid not null references knowledge_nodes(id) on delete cascade,
  to_node_id uuid not null references knowledge_nodes(id) on delete cascade,
  relationship_type text not null check (relationship_type in
    ('supports','contradicts','derived_from','raises','depends_on','related_to','refines','supersedes')),
  confidence real,
  source_id uuid references sources(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (from_node_id, to_node_id, relationship_type),
  check (from_node_id <> to_node_id)
);
create index knowledge_edges_to_idx on knowledge_edges (to_node_id);

-- ---------------------------------------------------------------------------
-- Tasks & runs
-- ---------------------------------------------------------------------------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('research','comment_reply','regenerate_draft')),
  objective text not null,
  status text not null default 'queued'
    check (status in ('queued','running','awaiting_approval','completed','failed','cancelled')),
  origin text not null check (origin in ('user','schedule','chat','system')),
  input jsonb not null default '{}',
  state jsonb not null default '{}',
  output jsonb,
  error text,
  parent_task_id uuid references tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index tasks_status_idx on tasks (status, created_at desc);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  workflow text not null,
  provider text,
  model text,
  task_id uuid references tasks(id) on delete set null,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  input jsonb not null default '{}',
  output jsonb,
  steps jsonb not null default '[]',
  tool_calls jsonb not null default '[]',
  llm_calls jsonb not null default '[]',
  usage jsonb not null default '{"inputTokens":0,"outputTokens":0}',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index agent_runs_started_idx on agent_runs (started_at desc);
create index agent_runs_task_idx on agent_runs (task_id);

-- ---------------------------------------------------------------------------
-- Posts, comments, replies (human-approval lifecycle)
-- ---------------------------------------------------------------------------
create table posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  status text not null default 'draft'
    check (status in ('draft','awaiting_review','approved','rejected','published')),
  task_id uuid references tasks(id) on delete set null,
  run_id uuid references agent_runs(id) on delete set null,
  external_id text,
  external_url text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  published_at timestamptz
);
create index posts_status_idx on posts (status, created_at desc);

create table comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  external_id text,
  author text not null,
  body text not null,
  classification text check (classification in
    ('question','criticism','supporting_evidence','contradictory_evidence','new_direction','noise')),
  processed_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (post_id, external_id)
);

create table replies (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references comments(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  body text not null,
  status text not null default 'draft'
    check (status in ('draft','awaiting_review','approved','rejected','published')),
  task_id uuid references tasks(id) on delete set null,
  run_id uuid references agent_runs(id) on delete set null,
  external_id text,
  external_url text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  published_at timestamptz
);
create index replies_status_idx on replies (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Settings & chat
-- ---------------------------------------------------------------------------
create table agent_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table chat_threads (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  tool_calls jsonb not null default '[]',
  run_id uuid references agent_runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index chat_messages_thread_idx on chat_messages (thread_id, created_at);

-- The app talks to Postgres directly with the service connection; lock the
-- tables down for the Supabase REST roles.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table sources enable row level security';
    execute 'alter table source_chunks enable row level security';
    execute 'alter table knowledge_nodes enable row level security';
    execute 'alter table knowledge_node_history enable row level security';
    execute 'alter table evidence enable row level security';
    execute 'alter table knowledge_edges enable row level security';
    execute 'alter table tasks enable row level security';
    execute 'alter table agent_runs enable row level security';
    execute 'alter table posts enable row level security';
    execute 'alter table comments enable row level security';
    execute 'alter table replies enable row level security';
    execute 'alter table agent_settings enable row level security';
    execute 'alter table chat_threads enable row level security';
    execute 'alter table chat_messages enable row level security';
  end if;
end $$;
