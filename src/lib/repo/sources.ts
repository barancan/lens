import { db, toVector } from "@/lib/db/client";
import type { Source, SourceChunk, SourceType } from "@/lib/types";

/**
 * Plain SQL access to `sources` and `source_chunks`. No business rules
 * beyond the SQL itself — dedupe, chunking policy, provenance, etc. live in
 * `src/lib/knowledge/service.ts`.
 */

interface SourceRow {
  id: string;
  source_type: SourceType;
  title: string;
  url: string | null;
  doi: string | null;
  authors: string[];
  publication_date: string | null;
  retrieved_at: Date;
  full_text: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface ChunkRow {
  id: string;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
}

function mapSource(row: SourceRow): Source {
  return {
    id: row.id,
    sourceType: row.source_type,
    title: row.title,
    url: row.url,
    doi: row.doi,
    authors: row.authors,
    publicationDate: row.publication_date,
    retrievedAt: row.retrieved_at.toISOString(),
    fullText: row.full_text,
    tags: row.tags,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function mapChunk(row: ChunkRow): SourceChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: row.metadata,
  };
}

export interface InsertSourceInput {
  sourceType: SourceType;
  title: string;
  url: string | null;
  doi: string | null;
  authors: string[];
  publicationDate: string | null;
  fullText: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

export async function insertSource(input: InsertSourceInput): Promise<Source> {
  const sql = db();
  const rows = await sql<SourceRow[]>`
    insert into sources (source_type, title, url, doi, authors, publication_date, full_text, tags, metadata)
    values (
      ${input.sourceType}, ${input.title}, ${input.url}, ${input.doi}, ${input.authors}::text[],
      ${input.publicationDate}, ${input.fullText}, ${input.tags}::text[], ${sql.json(input.metadata as never)}
    )
    returning id, source_type, title, url, doi, authors, publication_date::text as publication_date,
      retrieved_at, full_text, tags, metadata, created_at
  `;
  return mapSource(rows[0]);
}

export async function getSourceById(id: string): Promise<Source | null> {
  const sql = db();
  const rows = await sql<SourceRow[]>`
    select id, source_type, title, url, doi, authors, publication_date::text as publication_date,
      retrieved_at, full_text, tags, metadata, created_at
    from sources where id = ${id}
  `;
  return rows[0] ? mapSource(rows[0]) : null;
}

export async function getSourcesByIds(ids: string[]): Promise<Source[]> {
  if (ids.length === 0) return [];
  const sql = db();
  const rows = await sql<SourceRow[]>`
    select id, source_type, title, url, doi, authors, publication_date::text as publication_date,
      retrieved_at, full_text, tags, metadata, created_at
    from sources where id = any(${ids}::uuid[])
  `;
  return rows.map(mapSource);
}

/** Case-insensitive DOI lookup. */
export async function findSourceByDoi(doi: string): Promise<Source | null> {
  const sql = db();
  const rows = await sql<SourceRow[]>`
    select id, source_type, title, url, doi, authors, publication_date::text as publication_date,
      retrieved_at, full_text, tags, metadata, created_at
    from sources where lower(doi) = lower(${doi}) limit 1
  `;
  return rows[0] ? mapSource(rows[0]) : null;
}

export async function findSourceByUrl(url: string): Promise<Source | null> {
  const sql = db();
  const rows = await sql<SourceRow[]>`
    select id, source_type, title, url, doi, authors, publication_date::text as publication_date,
      retrieved_at, full_text, tags, metadata, created_at
    from sources where url = ${url} limit 1
  `;
  return rows[0] ? mapSource(rows[0]) : null;
}

export interface ListSourcesFilters {
  sourceTypes?: SourceType[];
  publishedAfter?: string;
  tags?: string[];
  text?: string;
  limit?: number;
  offset?: number;
}

export async function listSources(filters: ListSourcesFilters = {}): Promise<Source[]> {
  const sql = db();
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const rows = await sql<SourceRow[]>`
    select id, source_type, title, url, doi, authors, publication_date::text as publication_date,
      retrieved_at, full_text, tags, metadata, created_at
    from sources
    where 1=1
      ${filters.sourceTypes?.length ? sql`and source_type = any(${filters.sourceTypes}::text[])` : sql``}
      ${filters.publishedAfter ? sql`and publication_date >= ${filters.publishedAfter}::date` : sql``}
      ${filters.tags?.length ? sql`and tags && ${filters.tags}::text[]` : sql``}
      ${filters.text ? sql`and (title ilike ${"%" + filters.text + "%"} or full_text ilike ${"%" + filters.text + "%"})` : sql``}
    order by created_at desc
    limit ${limit} offset ${offset}
  `;
  return rows.map(mapSource);
}

export async function countSources(): Promise<number> {
  const sql = db();
  const rows = await sql<{ count: string }[]>`select count(*)::text as count from sources`;
  return Number(rows[0]?.count ?? 0);
}

export interface InsertChunkInput {
  chunkIndex: number;
  content: string;
  embedding: number[] | null;
}

/** Inserts chunks sequentially (preserves chunk_index order); no transaction needed. */
export async function insertSourceChunks(sourceId: string, chunks: InsertChunkInput[]): Promise<SourceChunk[]> {
  if (chunks.length === 0) return [];
  const sql = db();
  const inserted: SourceChunk[] = [];
  for (const chunk of chunks) {
    const rows = await sql<ChunkRow[]>`
      insert into source_chunks (source_id, chunk_index, content, embedding)
      values (${sourceId}, ${chunk.chunkIndex}, ${chunk.content}, ${toVector(chunk.embedding)}::vector)
      returning id, source_id, chunk_index, content, metadata
    `;
    inserted.push(mapChunk(rows[0]));
  }
  return inserted;
}

export async function getSourceChunksBySource(sourceId: string): Promise<SourceChunk[]> {
  const sql = db();
  const rows = await sql<ChunkRow[]>`
    select id, source_id, chunk_index, content, metadata from source_chunks
    where source_id = ${sourceId} order by chunk_index asc
  `;
  return rows.map(mapChunk);
}

export async function getChunksByIds(ids: string[]): Promise<SourceChunk[]> {
  if (ids.length === 0) return [];
  const sql = db();
  const rows = await sql<ChunkRow[]>`
    select id, source_id, chunk_index, content, metadata from source_chunks where id = any(${ids}::uuid[])
  `;
  return rows.map(mapChunk);
}

export async function getChunksWithNullEmbedding(limit: number): Promise<{ id: string; content: string }[]> {
  const sql = db();
  const rows = await sql<{ id: string; content: string }[]>`
    select id, content from source_chunks where embedding is null order by source_id, chunk_index limit ${limit}
  `;
  return rows;
}

export async function updateChunkEmbedding(id: string, embedding: number[]): Promise<void> {
  const sql = db();
  await sql`update source_chunks set embedding = ${toVector(embedding)}::vector where id = ${id}`;
}

export interface MatchSourceChunksFilters {
  sourceTypes?: SourceType[];
  publishedAfter?: string;
  excludeSourceIds?: string[];
}

/** Wraps the `match_source_chunks` SQL function. */
export async function matchSourceChunksByVector(
  embedding: number[],
  matchCount: number,
  filters: MatchSourceChunksFilters = {},
): Promise<{ id: string; sourceId: string; similarity: number }[]> {
  const sql = db();
  const rows = await sql<{ id: string; source_id: string; similarity: number }[]>`
    select id, source_id, similarity from match_source_chunks(
      ${toVector(embedding)}::vector,
      ${matchCount},
      ${filters.sourceTypes?.length ? filters.sourceTypes : null}::text[],
      ${filters.publishedAfter ?? null}::date,
      ${filters.excludeSourceIds?.length ? filters.excludeSourceIds : null}::uuid[]
    )
  `;
  return rows.map((r) => ({ id: r.id, sourceId: r.source_id, similarity: r.similarity }));
}
