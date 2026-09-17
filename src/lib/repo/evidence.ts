import { db } from "@/lib/db/client";
import type {
  Evidence,
  EvidenceStrength,
  EvidenceType,
  EvidenceWithSource,
  Independence,
  SourceType,
} from "@/lib/types";

/**
 * Plain SQL access to `evidence`. No business rules beyond the SQL itself —
 * provenance verification, confidence recompute, etc. live in
 * `src/lib/knowledge/service.ts`.
 */

interface EvidenceRow {
  id: string;
  claim_id: string;
  source_id: string;
  source_chunk_id: string | null;
  quote: string;
  evidence_type: EvidenceType;
  strength: EvidenceStrength;
  independence: Independence;
  notes: string | null;
  run_id: string | null;
  created_at: Date;
}

interface EvidenceWithSourceRow extends EvidenceRow {
  s_id: string;
  s_title: string;
  s_url: string | null;
  s_doi: string | null;
  s_source_type: SourceType;
  s_publication_date: string | null;
  s_authors: string[];
}

function mapEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    claimId: row.claim_id,
    sourceId: row.source_id,
    sourceChunkId: row.source_chunk_id,
    quote: row.quote,
    evidenceType: row.evidence_type,
    strength: row.strength,
    independence: row.independence,
    notes: row.notes,
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
  };
}

function mapEvidenceWithSource(row: EvidenceWithSourceRow): EvidenceWithSource {
  const source: EvidenceWithSource["source"] = {
    id: row.s_id,
    title: row.s_title,
    url: row.s_url,
    doi: row.s_doi,
    sourceType: row.s_source_type,
    publicationDate: row.s_publication_date,
    authors: row.s_authors,
  };
  return { ...mapEvidence(row), source };
}

export interface InsertEvidenceInput {
  claimId: string;
  sourceId: string;
  sourceChunkId: string | null;
  quote: string;
  evidenceType: EvidenceType;
  strength: EvidenceStrength;
  independence: Independence;
  notes: string | null;
  runId: string | null;
}

/** Idempotent on (claim_id, source_id, quote) via the DB unique constraint. */
export async function insertEvidenceIfNew(
  input: InsertEvidenceInput,
): Promise<{ evidence: Evidence; created: boolean }> {
  const sql = db();
  const inserted = await sql<EvidenceRow[]>`
    insert into evidence (claim_id, source_id, source_chunk_id, quote, evidence_type, strength, independence, notes, run_id)
    values (
      ${input.claimId}, ${input.sourceId}, ${input.sourceChunkId}, ${input.quote}, ${input.evidenceType},
      ${input.strength}, ${input.independence}, ${input.notes}, ${input.runId}
    )
    on conflict (claim_id, source_id, quote) do nothing
    returning id, claim_id, source_id, source_chunk_id, quote, evidence_type, strength, independence, notes, run_id, created_at
  `;
  if (inserted[0]) return { evidence: mapEvidence(inserted[0]), created: true };

  const existing = await sql<EvidenceRow[]>`
    select id, claim_id, source_id, source_chunk_id, quote, evidence_type, strength, independence, notes, run_id, created_at
    from evidence where claim_id = ${input.claimId} and source_id = ${input.sourceId} and quote = ${input.quote}
  `;
  return { evidence: mapEvidence(existing[0]), created: false };
}

export async function getEvidenceForNode(nodeId: string, types?: EvidenceType[]): Promise<Evidence[]> {
  const sql = db();
  const rows = await sql<EvidenceRow[]>`
    select id, claim_id, source_id, source_chunk_id, quote, evidence_type, strength, independence, notes, run_id, created_at
    from evidence
    where claim_id = ${nodeId}
      ${types?.length ? sql`and evidence_type = any(${types}::text[])` : sql``}
    order by created_at asc
  `;
  return rows.map(mapEvidence);
}

export async function getEvidenceWithSourceForNode(
  nodeId: string,
  types?: EvidenceType[],
): Promise<EvidenceWithSource[]> {
  const sql = db();
  const rows = await sql<EvidenceWithSourceRow[]>`
    select e.id, e.claim_id, e.source_id, e.source_chunk_id, e.quote, e.evidence_type, e.strength, e.independence,
      e.notes, e.run_id, e.created_at,
      s.id as s_id, s.title as s_title, s.url as s_url, s.doi as s_doi, s.source_type as s_source_type,
      s.publication_date::text as s_publication_date, s.authors as s_authors
    from evidence e
    join sources s on s.id = e.source_id
    where e.claim_id = ${nodeId}
      ${types?.length ? sql`and e.evidence_type = any(${types}::text[])` : sql``}
    order by e.created_at asc
  `;
  return rows.map(mapEvidenceWithSource);
}

export interface ListEvidenceFilters {
  evidenceTypes?: EvidenceType[];
  sourceId?: string;
  claimId?: string;
  limit?: number;
  offset?: number;
}

export interface EvidenceListItem extends EvidenceWithSource {
  claimStatement: string;
}

export async function listEvidence(filters: ListEvidenceFilters = {}): Promise<EvidenceListItem[]> {
  const sql = db();
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const rows = await sql<(EvidenceWithSourceRow & { claim_statement: string })[]>`
    select e.id, e.claim_id, e.source_id, e.source_chunk_id, e.quote, e.evidence_type, e.strength, e.independence,
      e.notes, e.run_id, e.created_at,
      s.id as s_id, s.title as s_title, s.url as s_url, s.doi as s_doi, s.source_type as s_source_type,
      s.publication_date::text as s_publication_date, s.authors as s_authors,
      n.statement as claim_statement
    from evidence e
    join sources s on s.id = e.source_id
    join knowledge_nodes n on n.id = e.claim_id
    where 1=1
      ${filters.evidenceTypes?.length ? sql`and e.evidence_type = any(${filters.evidenceTypes}::text[])` : sql``}
      ${filters.sourceId ? sql`and e.source_id = ${filters.sourceId}` : sql``}
      ${filters.claimId ? sql`and e.claim_id = ${filters.claimId}` : sql``}
    order by e.created_at desc
    limit ${limit} offset ${offset}
  `;
  return rows.map((r) => ({ ...mapEvidenceWithSource(r), claimStatement: r.claim_statement }));
}

export async function countEvidence(): Promise<number> {
  const sql = db();
  const rows = await sql<{ count: string }[]>`select count(*)::text as count from evidence`;
  return Number(rows[0]?.count ?? 0);
}
