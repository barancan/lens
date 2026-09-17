import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader, Section, Tag, formatDate } from "@/components/common";
import { getKnowledgeService } from "@/lib/workflows/runtime";

export default async function SourceDetailPage(props: PageProps<"/knowledge/sources/[id]">) {
  const { id } = await props.params;
  const k = getKnowledgeService();
  const [source, chunks, evidence] = await Promise.all([
    k.getSource(id),
    k.getSourceChunks(id),
    k.listEvidence({ sourceId: id, limit: 200 }),
  ]);
  if (!source) notFound();

  const textKind = typeof source.metadata.textKind === "string" ? source.metadata.textKind : "—";

  return (
    <div>
      <PageHeader title={source.title} description={`${source.sourceType} · retrieved ${formatDate(source.retrievedAt, false)}`} />

      <dl className="mb-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Type</dt>
          <dd>{source.sourceType}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Published</dt>
          <dd>{formatDate(source.publicationDate, false)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Authors</dt>
          <dd>{source.authors.length > 0 ? source.authors.join(", ") : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Text kind</dt>
          <dd>{textKind}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">DOI</dt>
          <dd>
            {source.doi ? (
              <a
                href={`https://doi.org/${source.doi}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                {source.doi}
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">URL</dt>
          <dd>
            {source.url ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-all hover:underline">
                {source.url}
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      {source.tags.length > 0 ? (
        <div className="mb-8 flex flex-wrap gap-1.5">
          {source.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      ) : null}

      <Section title="Evidence from this source">
        {evidence.length === 0 ? (
          <EmptyState>No evidence recorded from this source.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {evidence.map((e) => (
              <li key={e.id} className="rounded-md border p-3 text-sm">
                <blockquote className="mb-1 border-l-2 pl-2 text-muted-foreground italic">
                  &ldquo;{e.quote}&rdquo;
                </blockquote>
                <Link href={`/knowledge/nodes/${e.claimId}`} className="hover:underline">
                  {e.claimStatement}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Full text">
        {chunks.length === 0 ? (
          <EmptyState>No stored chunks.</EmptyState>
        ) : (
          <div className="space-y-2">
            {chunks.map((c) => (
              <details key={c.id} className="rounded-md border p-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">Chunk {c.chunkIndex + 1}</summary>
                <p className="mt-2 whitespace-pre-wrap">{c.content}</p>
              </details>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
