# LENS

LENS is a single-purpose scientific research agent. It investigates one question:

> **Can partial cellular reprogramming reverse aspects of biological aging without creating unacceptable cancer risk?**

LENS builds up structured, provenance-tracked knowledge from the literature. It drafts research updates and replies to comments on them. **Nothing is published without explicit human approval.** One operator runs it through a private web UI.

- **Stack:** Next.js 16 (App Router) · TypeScript · Tailwind + shadcn/ui · Postgres + pgvector (Supabase) · direct Anthropic and OpenAI APIs.
- **Not used:** agent frameworks, a separate vector or graph database, background workers.

---

## Architecture

```
Browser ──server actions / route handlers──▶ domain layer (src/lib)
                                              ├─ auth/           single-user login, signed session cookie
                                              ├─ repo/           the ONLY code that issues SQL
                                              ├─ knowledge/      Knowledge API, confidence + impact heuristics, hybrid retrieval
                                              ├─ llm/            provider-neutral types, registry, structured output
                                              ├─ providers/      anthropic · openai · bios (stub) · local (stub)
                                              ├─ integrations/   research sources · openlabs · bios (stub) · mcp (interface)
                                              ├─ tools/          AgentTool interface + chat tools
                                              ├─ workflows/      explicit step machines: research, comment, regenerate, chat
                                              ├─ approvals/      draft lifecycle + Publisher adapter
                                              └─ settings/       DB-stored agent configuration (zod-validated)
Vercel Cron ──▶ /api/cron/research ──▶ task ──▶ research workflow
```

### Boundaries
- **Business logic sees only neutral LLM types.** Workflows use `LLMRequest` / `LLMResponse` from `src/lib/llm/types.ts`, and resolve models by *workflow key* (`research_planner`, `post_writer`, …) from the `models` setting. Anthropic and OpenAI SDK formats appear only in `src/lib/providers/<name>/`.
- **Workflows never touch tables.** Knowledge goes through `KnowledgeService` (`src/lib/knowledge/service.ts`), and operational data goes through `src/lib/repo/*`.
- **External systems are adapters.** Research sources implement `ResearchSource`. Publishing and comment ingestion implement `Publisher` / `CommentSource`.
- **Structured LLM output is always validated.** `generateStructured()` validates against a zod schema and allows one repair attempt; anything still invalid fails the step.

### Knowledge model (`supabase/migrations`)

| Table | Purpose |
| --- | --- |
| `sources`, `source_chunks` | Papers, preprints, pages and comments. Chunks carry pgvector embeddings. |
| `knowledge_nodes` | `claim`, `observation`, `hypothesis`, `insight` or `question`, each with `origin` (`source_derived`, `agent_generated` or `operator`), `status`, `confidence`, `impact` and an embedding. |
| `knowledge_node_history` | Every confidence and status change, with a reason. |
| `evidence` | Links a claim-like node to a **verbatim quote** from a source. Types: supports, contradicts, replicates, challenges, contextualizes. |
| `knowledge_edges` | Relationships between nodes: supports, contradicts, derived_from, raises, depends_on, related_to, refines, supersedes. |
| `posts`, `comments`, `replies` | Drafts and the approval lifecycle. |
| `tasks`, `agent_runs` | Checkpointed task state; step, tool-call, LLM-call and token logs. |
| `agent_settings`, `chat_threads`, `chat_messages` | Configuration and operator chat. |

### Scientific guardrails
These are enforced in code, not only in prompts:
- **Evidence needs a real source and a verbatim quote.** The quote must be found in that source's text; otherwise `ProvenanceError` is raised and the finding is recorded as rejected.
- **Insights are always agent-generated.** A DB constraint enforces this. An insight must be `derived_from` existing nodes, and can never be attached as evidence.
- **Comment text never becomes evidence.** A comment can raise a question; evidence comes only from sources the agent actually fetched.
- **Confidence is a transparent heuristic** over evidence strength and independence (`src/lib/knowledge/confidence.ts`). Statuses are `supported`, `contested`, `weak` and `unresolved` rather than true/false.
- **Impact is a transparent heuristic too** (`src/lib/knowledge/impact.ts`): `headroom × reach`, where headroom is how much room a finding has left to move and reach is the saturated sum of what its neighbours — linked by a recorded `knowledge_edges` relationship, or by embedding similarity — stand to gain. It answers "would drilling into this move *other* findings?", and every score stores the breakdown and a plain-English reason list. Unlike confidence it depends on the neighbourhood, so it is recomputed in batches (end of each run, or **Knowledge → Recompute impact**) and never bumps `updated_at`.
- **The score never steers the agent by itself.** It is shown to the operator, who can queue a finding for the next cycle; only then does the planner see it, at the top of its prompt, with the operator's note. The queue holds at most 10 findings and is ordered by hand (drag-and-drop on the dashboard) rather than by impact, since impact is derived and would otherwise reshuffle the operator's shortlist whenever a run rescores. A queued request is consumed once a run has actually stored knowledge, so a failed run leaves it queued.
- **Retrieval labels provenance.** Context passed to models is labelled `[SOURCE QUOTE]` / `[SOURCE EXCERPT]` or `[CLAIM]` / `[AGENT INSIGHT]` / `[QUESTION]`, so the model can tell source material from interpretation.
- **Post citations are checked.** Citations are validated against the sources actually retrieved; invented `[n]` markers are removed, and the numbered source list is generated by code.

### Workflows (`src/lib/workflows`)

All workflows run on one engine (`engine.ts`):
- steps run in a fixed order, with no recursion;
- state is checkpointed to `tasks.state` after every step, so a failed or timed-out task can be **resumed** and completed steps are skipped;
- every tool and LLM call is logged to `agent_runs`;
- limits (queries, sources, findings, tool calls, follow-ups, chat rounds, drill-down targets) come from the `limits` setting.

| Workflow | Steps |
| --- | --- |
| **Research** (loop 1) | plan → search → select → read → extract → compare → store → synthesize → assess_impact → draft |
| **Comment** (loop 2) | classify → research (bounded) → update_knowledge → draft_reply |
| **Regenerate** | rewrite a post or reply using operator feedback (earlier versions are kept in `metadata.revisions`) |
| **Chat** | bounded tool-use loop. Tools: search_knowledge, get_claim, list_knowledge, get_source, search_literature, start_research, draft_post, respond_to_comment, list_unprocessed_comments, record_question, add_focus_directive, list_runs, get_run, get_task |

**Long-running work.** A task is created in the database and then executed with `after()` inside a route with `maxDuration = 300`. A task that exceeds the limit stays `running`. You can resume it from the Runs page, and the cron also resumes it once it is stale.

### Approval lifecycle
```
draft → awaiting_review → approved → published
               │   ▲
               ▼   │ regenerate
            rejected
```
- **Edit** keeps `awaiting_review` and records a revision.
- **Publish** calls the configured `Publisher`. Without `OPENLABS_AGENT_CREDENTIAL` set, `getPublisher()` falls back to `ManualPublisher`, which just records that you posted the draft yourself. With it set, `OpenLabsPublisher` posts the draft to OpenLabs for real — see [OpenLabs](#openlabs) below.

---

## Local development

Requirements: Node 20+ and pnpm. Docker is **not** required: local Postgres is [PGlite](https://pglite.dev) (Postgres in WASM, with pgvector).

1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Create your local env file:
   ```bash
   cp .env.example .env.local
   ```
3. Generate the login hash, and paste the escaped line it prints into `.env.local`:
   ```bash
   pnpm hash-password 'your-password'
   ```
4. Generate a session secret and set it as `SESSION_SECRET`:
   ```bash
   openssl rand -base64 48
   ```
5. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
   `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres`.
6. In terminal 1, start the local database. It applies migrations on start and keeps running:
   ```bash
   pnpm db:local
   ```
7. In terminal 2, seed the database and start the app:
   ```bash
   pnpm db:seed        # research question, 12 research themes (as open questions), default settings
   pnpm dev            # http://localhost:3000
   ```

To target a real Supabase database instead, set `DATABASE_URL` and run `pnpm db:migrate && pnpm db:seed`.

**Useful commands**

| Command | |
| --- | --- |
| `pnpm test` | Vitest: domain logic against real Postgres (PGlite), with LLMs mocked |
| `pnpm typecheck` / `pnpm lint` | |
| `pnpm db:migrate` | Apply `supabase/migrations/*.sql` to `DATABASE_URL` |
| `pnpm db:seed` | Idempotent seed |
| `pnpm db:seed:sql` | Regenerate `supabase/seed.sql` |

The seed deliberately contains **no** claims or evidence. The 12 themes are stored as open questions: starting directions, not conclusions. Seeded questions have no embeddings until **Knowledge → Backfill embeddings** runs (or the first research run touches them).

---

## OpenLabs

[OpenLabs](https://openlabs.bio.xyz) is the platform LENS publishes to: `OpenLabsPublisher` posts approved drafts as `discussion` or `claim` posts and replies, and `OpenLabsCommentSource` reads back comments so the comment-reply workflow can respond. It is entirely optional — without it, `getPublisher()` falls back to `ManualPublisher` and nothing in the app breaks.

There is **no API key**. Authentication is a permanent `agentCredential`, obtained once, that mints short-lived session tokens per request.

1. **One-time registration** (never automated — this creates a real, permanent account, so run it yourself, not in CI or from an agent):
   ```bash
   pnpm openlabs:onboard --display-name "LENS" --description "..."
   ```
   The `displayName` you choose becomes the permanent public handle (3–30 chars, lowercase/digits/underscore; the platform suffixes collisions). The script refuses to run if `OPENLABS_AGENT_CREDENTIAL` is already set, since duplicate accounts aren't allowed and credentials can't be recovered or rotated through it. Use `--dry-run` to preview the requests first.
2. **Store the credential.** The script prints the `agentCredential` once. It is irreplaceable — put it in a password manager immediately, then paste the printed `OPENLABS_AGENT_CREDENTIAL=...` line into `.env.local` (or the Vercel dashboard). Never commit it.
3. **Verify** the credential is valid:
   ```bash
   pnpm openlabs:smoke
   ```
4. **Choose behavior.** Settings → OpenLabs sets the default topic, post type (discussion vs. claim), tags, and comment-polling limits. The card shows whether OpenLabs is actually connected (env-only) — the form is usable either way, but takes effect once `OPENLABS_AGENT_CREDENTIAL` is set.
5. **Publishing stays operator-driven.** A draft still must be approved and then published by hand from the drafts UI — nothing reaches OpenLabs automatically on approval.

---

## Deployment (Vercel + Supabase)

1. **Supabase.** Create a project, then either:
   - run `supabase db push` with the migrations in `supabase/migrations` (and seed with `supabase/seed.sql`), **or**
   - set `DATABASE_URL` locally to the project's connection string and run `pnpm db:migrate && pnpm db:seed`.

   Row-level security is enabled on all tables. The app connects directly with the database role, so the REST API exposes nothing.
2. **Vercel.** Import the repository and set these environment variables:
   - `DATABASE_URL`: the **transaction pooler** URL, port 6543. Prepared statements are disabled in the client for pooler compatibility.
   - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
   - `APP_USERNAME`, `APP_PASSWORD_HASH` (the raw bcrypt hash; no escaping in the dashboard), `SESSION_SECRET`
   - `CRON_SECRET`
   - optionally `CONTACT_EMAIL`, the `SUPABASE_*` values, and `OPENLABS_AGENT_CREDENTIAL` (plus `OPENLABS_API_URL` / `OPENLABS_ID_API_URL` / `OPENLABS_PUBLIC_URL` if targeting a non-default OpenLabs environment) — see [OpenLabs](#openlabs)
3. **Cron.** `vercel.json` schedules `/api/cron/research` daily at 06:00 UTC. It skips if research is already in progress, and resumes a stale task instead of starting a new one. Hobby plans allow daily crons; adjust the schedule on Pro.
4. **Function duration.** Agent routes declare `maxDuration = 300`. Enable Fluid Compute (the default for new projects) so this limit is available. Lower `limits.maxSourcesPerRun` if runs approach the limit.

---

## Extending

| To add… | Do this |
| --- | --- |
| **A model provider** (e.g. BIOS, a local model) | Implement `LLMProvider` in `src/lib/providers/<name>/adapter.ts` and register it in `src/lib/llm/registry.ts`. Then select it per workflow in Settings. |
| **A research source** (PubMed E-utilities, bioRxiv API, Reddit, web search, BIOS) | Implement `ResearchSource` in `src/lib/integrations/research/`, register it in `registry.ts`, and enable it in Settings → Project. |
| **Another publishing target** | Implement `Publisher` / `CommentSource` (see `src/lib/integrations/openlabs` for a worked example) and wire it into `getPublisher()` / `getCommentSource()`. |
| **MCP tools** | Adapt `McpToolServer` tools into `AgentTool`s (`src/lib/integrations/mcp`). |
