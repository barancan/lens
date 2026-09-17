import Link from "next/link";
import { notFound } from "next/navigation";
import {
  EmptyState,
  EvidenceTypeBadge,
  NodeStatusBadge,
  NodeTypeBadge,
  PageHeader,
  Section,
  Tag,
  formatConfidence,
  formatDate,
} from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EvidenceWithSource } from "@/lib/types";
import { getKnowledgeService } from "@/lib/workflows/runtime";

export default async function NodeDetailPage(props: PageProps<"/knowledge/nodes/[id]">) {
  const { id } = await props.params;
  const k = getKnowledgeService();
  const detail = await k.getClaim(id);
  if (!detail) notFound();

  const { node, supporting, contradicting, contextual, related, questions, sources, history } = detail;

  return (
    <div>
      <PageHeader
        title={node.statement}
        description={node.summary ?? undefined}
        actions={
          <>
            <NodeTypeBadge type={node.type} origin={node.origin} />
            <NodeStatusBadge status={node.status} />
          </>
        }
      />

      <dl className="mb-8 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Confidence</dt>
          <dd>{formatConfidence(node.confidence)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Created</dt>
          <dd>{formatDate(node.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Updated</dt>
          <dd>{formatDate(node.updatedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Tags</dt>
          <dd>{node.tags.length > 0 ? node.tags.join(", ") : "—"}</dd>
        </div>
      </dl>

      <EvidenceSection title="Supporting evidence" items={supporting} />
      <EvidenceSection title="Contradictory evidence" items={contradicting} />
      <EvidenceSection title="Contextual evidence" items={contextual} />

      <Section title="Related knowledge">
        {related.length === 0 ? (
          <EmptyState>No related knowledge.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {related.map((r) => (
              <li key={r.edge.id} className="rounded-md border p-2 text-sm">
                <span className="text-muted-foreground">
                  {r.direction === "outgoing" ? `${r.edge.relationshipType} →` : `← ${r.edge.relationshipType}`}
                </span>{" "}
                <Link href={`/knowledge/nodes/${r.node.id}`} className="hover:underline">
                  {r.node.statement}
                </Link>{" "}
                <NodeTypeBadge type={r.node.type} origin={r.node.origin} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Open questions">
        {questions.length === 0 ? (
          <EmptyState>No open questions.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {questions.map((qn) => (
              <li key={qn.id} className="rounded-md border p-2 text-sm">
                <Link href={`/knowledge/nodes/${qn.id}`} className="hover:underline">
                  {qn.statement}
                </Link>{" "}
                <NodeStatusBadge status={qn.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sources">
        {sources.length === 0 ? (
          <EmptyState>No sources.</EmptyState>
        ) : (
          <ul className="space-y-1 text-sm">
            {sources.map((s) => (
              <li key={s.id}>
                <Link href={`/knowledge/sources/${s.id}`} className="hover:underline">
                  {s.title}
                </Link>{" "}
                <span className="text-muted-foreground">({formatDate(s.publicationDate, false)})</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Confidence / status history">
        {history.length === 0 ? (
          <EmptyState>No history recorded.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{formatDate(h.createdAt)}</TableCell>
                  <TableCell>{formatConfidence(h.confidence)}</TableCell>
                  <TableCell>
                    <NodeStatusBadge status={h.status} />
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal">{h.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function EvidenceSection({ title, items }: { title: string; items: EvidenceWithSource[] }) {
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <EmptyState>None recorded.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {items.map((e) => (
            <li key={e.id} className="rounded-md border p-3">
              <blockquote className="mb-2 border-l-2 pl-3 text-sm text-muted-foreground italic">
                &ldquo;{e.quote}&rdquo;
              </blockquote>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <EvidenceTypeBadge type={e.evidenceType} />
                <Tag>{e.strength}</Tag>
                <Tag>{e.independence}</Tag>
                <Link href={`/knowledge/sources/${e.source.id}`} className="text-muted-foreground hover:underline">
                  {e.source.title}
                </Link>
                <span className="text-muted-foreground">{formatDate(e.source.publicationDate, false)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
