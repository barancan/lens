import Link from "next/link";
import {
  EmptyState,
  EvidenceTypeBadge,
  NodeStatusBadge,
  NodeTypeBadge,
  PageHeader,
  Section,
  formatConfidence,
  formatDate,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { NODE_STATUSES, type KnowledgeNode, type NodeStatus, type NodeType } from "@/lib/types";
import type { KnowledgeService } from "@/lib/knowledge/service";
import { getKnowledgeService } from "@/lib/workflows/runtime";
import { BackfillButton } from "./backfill-button";

const NODE_TABS: Record<string, NodeType> = {
  claims: "claim",
  observations: "observation",
  hypotheses: "hypothesis",
  insights: "insight",
  questions: "question",
};
const TAB_ORDER = ["claims", "observations", "hypotheses", "insights", "questions", "evidence", "sources"] as const;
type Tab = (typeof TAB_ORDER)[number];

const PAGE_SIZE = 50;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function isTab(v: string | undefined): v is Tab {
  return !!v && (TAB_ORDER as readonly string[]).includes(v);
}

function isNodeStatus(v: string | undefined): v is NodeStatus {
  return !!v && (NODE_STATUSES as readonly string[]).includes(v);
}

function buildQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) usp.set(key, value);
  }
  return usp.toString();
}

export default async function KnowledgePage(props: PageProps<"/knowledge">) {
  const sp = await props.searchParams;
  const tabRaw = first(sp.tab);
  const tab: Tab = isTab(tabRaw) ? tabRaw : "claims";
  const q = first(sp.q)?.trim() ?? "";
  const statusRaw = first(sp.status);
  const status = isNodeStatus(statusRaw) ? statusRaw : undefined;
  const minConfidenceRaw = first(sp.minConfidence);
  const minConfidenceParsed = minConfidenceRaw ? Number(minConfidenceRaw) : undefined;
  const minConfidence = minConfidenceParsed !== undefined && Number.isFinite(minConfidenceParsed) ? minConfidenceParsed : undefined;
  const pageRaw = Number(first(sp.page) ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const k = getKnowledgeService();

  return (
    <div>
      <PageHeader title="Knowledge" actions={<BackfillButton />} />

      <nav className="mb-4 flex flex-wrap gap-1 border-b pb-2">
        {TAB_ORDER.map((t) => (
          <Link
            key={t}
            href={`/knowledge?tab=${t}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm capitalize",
              t === tab
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t}
          </Link>
        ))}
      </nav>

      <form method="get" className="mb-8 flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value={tab} />
        <div className="min-w-48 flex-1">
          <label htmlFor="q" className="mb-1 block text-xs font-medium text-muted-foreground">
            Search
          </label>
          <Input id="q" name="q" defaultValue={q} placeholder="Hybrid search across knowledge and sources" />
        </div>
        <div>
          <label htmlFor="status" className="mb-1 block text-xs font-medium text-muted-foreground">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ""}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">Any</option>
            {NODE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="minConfidence" className="mb-1 block text-xs font-medium text-muted-foreground">
            Min confidence
          </label>
          <input
            id="minConfidence"
            name="minConfidence"
            type="number"
            step="0.05"
            min="0"
            max="1"
            defaultValue={minConfidenceRaw ?? ""}
            className="h-8 w-24 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          />
        </div>
        <button type="submit" className={buttonVariants({ variant: "secondary" })}>
          Apply
        </button>
      </form>

      {q ? (
        <SearchResults k={k} q={q} status={status} minConfidence={minConfidence} />
      ) : tab === "evidence" ? (
        <EvidenceTab k={k} page={page} />
      ) : tab === "sources" ? (
        <SourcesTab k={k} page={page} />
      ) : (
        <NodeTab k={k} type={NODE_TABS[tab]} status={status} minConfidence={minConfidence} page={page} />
      )}
    </div>
  );
}

function Pagination({
  base,
  page,
  hasMore,
}: {
  base: Record<string, string | undefined>;
  page: number;
  hasMore: boolean;
}) {
  const prevQuery = buildQuery({ ...base, page: String(page - 1) });
  const nextQuery = buildQuery({ ...base, page: String(page + 1) });
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span className="text-muted-foreground">Page {page}</span>
      <div className="flex gap-3">
        {page > 1 ? (
          <Link href={`/knowledge?${prevQuery}`} className="hover:underline">
            Previous
          </Link>
        ) : (
          <span className="text-muted-foreground">Previous</span>
        )}
        {hasMore ? (
          <Link href={`/knowledge?${nextQuery}`} className="hover:underline">
            Next
          </Link>
        ) : (
          <span className="text-muted-foreground">Next</span>
        )}
      </div>
    </div>
  );
}

async function NodeTab({
  k,
  type,
  status,
  minConfidence,
  page,
}: {
  k: KnowledgeService;
  type: NodeType;
  status?: NodeStatus;
  minConfidence?: number;
  page: number;
}) {
  const offset = (page - 1) * PAGE_SIZE;
  const nodes = await k.listNodes({
    types: [type],
    statuses: status ? [status] : undefined,
    minConfidence,
    limit: PAGE_SIZE + 1,
    offset,
  });
  const hasMore = nodes.length > PAGE_SIZE;
  const items = nodes.slice(0, PAGE_SIZE);
  const tab = Object.entries(NODE_TABS).find(([, t]) => t === type)?.[0] ?? type;

  return (
    <Section title={tab}>
      {items.length === 0 ? (
        <EmptyState>No {type}s match these filters.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Statement</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Origin / type</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((n) => (
              <TableRow key={n.id}>
                <TableCell className="max-w-md whitespace-normal">
                  <Link href={`/knowledge/nodes/${n.id}`} className="hover:underline">
                    {n.statement}
                  </Link>
                </TableCell>
                <TableCell>
                  <NodeStatusBadge status={n.status} />
                </TableCell>
                <TableCell>{formatConfidence(n.confidence)}</TableCell>
                <TableCell>
                  <NodeTypeBadge type={n.type} origin={n.origin} />
                </TableCell>
                <TableCell>{formatDate(n.updatedAt, false)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination
        base={{ tab, status, minConfidence: minConfidence !== undefined ? String(minConfidence) : undefined }}
        page={page}
        hasMore={hasMore}
      />
    </Section>
  );
}

async function EvidenceTab({ k, page }: { k: KnowledgeService; page: number }) {
  const offset = (page - 1) * PAGE_SIZE;
  const items = await k.listEvidence({ limit: PAGE_SIZE + 1, offset });
  const hasMore = items.length > PAGE_SIZE;
  const rows = items.slice(0, PAGE_SIZE);

  return (
    <Section title="Evidence">
      {rows.length === 0 ? (
        <EmptyState>No evidence recorded yet.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quote</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Strength</TableHead>
              <TableHead>Independence</TableHead>
              <TableHead>Claim</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="max-w-sm whitespace-normal text-muted-foreground italic">
                  &ldquo;{e.quote}&rdquo;
                </TableCell>
                <TableCell>
                  <EvidenceTypeBadge type={e.evidenceType} />
                </TableCell>
                <TableCell>{e.strength}</TableCell>
                <TableCell>{e.independence}</TableCell>
                <TableCell className="max-w-xs truncate">
                  <Link href={`/knowledge/nodes/${e.claimId}`} className="hover:underline">
                    {e.claimStatement}
                  </Link>
                </TableCell>
                <TableCell className="max-w-xs truncate">
                  <Link href={`/knowledge/sources/${e.source.id}`} className="hover:underline">
                    {e.source.title}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination base={{ tab: "evidence" }} page={page} hasMore={hasMore} />
    </Section>
  );
}

async function SourcesTab({ k, page }: { k: KnowledgeService; page: number }) {
  const offset = (page - 1) * PAGE_SIZE;
  const items = await k.listSources({ limit: PAGE_SIZE + 1, offset });
  const hasMore = items.length > PAGE_SIZE;
  const rows = items.slice(0, PAGE_SIZE);

  return (
    <Section title="Sources">
      {rows.length === 0 ? (
        <EmptyState>No sources yet.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Authors</TableHead>
              <TableHead>DOI / URL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="max-w-sm truncate">
                  <Link href={`/knowledge/sources/${s.id}`} className="hover:underline">
                    {s.title}
                  </Link>
                </TableCell>
                <TableCell>{s.sourceType}</TableCell>
                <TableCell>{formatDate(s.publicationDate, false)}</TableCell>
                <TableCell className="max-w-40 truncate">{s.authors.join(", ") || "—"}</TableCell>
                <TableCell className="max-w-48 truncate">
                  {s.doi ? (
                    <a
                      href={`https://doi.org/${s.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {s.doi}
                    </a>
                  ) : s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {s.url}
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination base={{ tab: "sources" }} page={page} hasMore={hasMore} />
    </Section>
  );
}

async function SearchResults({
  k,
  q,
  status,
  minConfidence,
}: {
  k: KnowledgeService;
  q: string;
  status?: NodeStatus;
  minConfidence?: number;
}) {
  let fallbackNodes: KnowledgeNode[] | null = null;
  let context: Awaited<ReturnType<KnowledgeService["searchKnowledge"]>> | null = null;
  try {
    context = await k.searchKnowledge(q, { statuses: status ? [status] : undefined, minConfidence });
  } catch (err) {
    console.error("[lens] searchKnowledge failed, falling back to keyword search", err);
    fallbackNodes = await k.listNodes({
      text: q,
      statuses: status ? [status] : undefined,
      minConfidence,
      limit: 20,
    });
  }

  if (fallbackNodes) {
    return (
      <Section title="Search results">
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Embedding search unavailable</AlertTitle>
          <AlertDescription>Falling back to a plain keyword match on statement/summary.</AlertDescription>
        </Alert>
        {fallbackNodes.length === 0 ? (
          <EmptyState>No matches for &ldquo;{q}&rdquo;.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {fallbackNodes.map((n) => (
              <li key={n.id} className="rounded-lg border p-3">
                <Link href={`/knowledge/nodes/${n.id}`} className="block hover:underline">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <NodeTypeBadge type={n.type} origin={n.origin} />
                    <NodeStatusBadge status={n.status} />
                    <span className="text-xs text-muted-foreground">confidence {formatConfidence(n.confidence)}</span>
                  </div>
                  <p className="text-sm">{n.statement}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    );
  }

  const ctx = context!;
  return (
    <Section title="Search results">
      {ctx.nodes.length === 0 && ctx.chunks.length === 0 ? (
        <EmptyState>No matches for &ldquo;{q}&rdquo;.</EmptyState>
      ) : (
        <>
          {ctx.nodes.length > 0 ? (
            <ul className="mb-6 space-y-3">
              {ctx.nodes.map((rn) => (
                <li key={rn.node.id} className="rounded-lg border p-3">
                  <Link href={`/knowledge/nodes/${rn.node.id}`} className="block hover:underline">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <NodeTypeBadge type={rn.node.type} origin={rn.node.origin} />
                      <NodeStatusBadge status={rn.node.status} />
                      <span className="text-xs text-muted-foreground">
                        confidence {formatConfidence(rn.node.confidence)} · supports {rn.supportCount} · contradicts{" "}
                        {rn.contradictCount}
                      </span>
                    </div>
                    <p className="text-sm">{rn.node.statement}</p>
                  </Link>
                  {rn.topEvidence.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {rn.topEvidence.map((e) => (
                        <blockquote key={e.id} className="border-l-2 pl-2 text-xs text-muted-foreground italic">
                          &ldquo;{e.quote}&rdquo; —{" "}
                          <Link href={`/knowledge/sources/${e.source.id}`} className="hover:underline">
                            {e.source.title}
                          </Link>
                        </blockquote>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {ctx.chunks.length > 0 ? (
            <>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Source excerpts
              </h3>
              <ul className="space-y-2">
                {ctx.chunks.map((rc) => (
                  <li key={rc.chunk.id} className="rounded-lg border p-3">
                    <Link href={`/knowledge/sources/${rc.source.id}`} className="mb-1 block text-sm hover:underline">
                      {rc.source.title}
                    </Link>
                    <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground italic">
                      {rc.chunk.content}
                    </blockquote>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </Section>
  );
}
