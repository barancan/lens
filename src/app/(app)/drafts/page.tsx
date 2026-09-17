import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState, PageHeader, Section, StatusBadge, formatDate } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { listTasks } from "@/lib/repo/tasks";
import { listPosts } from "@/lib/repo/posts";
import { listReplies } from "@/lib/repo/replies";
import type { DraftStatus, Post, Reply } from "@/lib/types";

const STATUS_FILTERS = ["awaiting_review", "approved", "rejected", "published", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function truncate(text: string | undefined, max: number): string {
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? body;
  return truncate(line, 100);
}

export default async function DraftsPage(props: PageProps<"/drafts">) {
  const params = await props.searchParams;
  const raw = Array.isArray(params.status) ? params.status[0] : params.status;
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as StatusFilter)
    : "awaiting_review";
  const statuses: DraftStatus[] | undefined = status === "all" ? undefined : [status];

  const [posts, replies, activeTasks] = await Promise.all([
    listPosts({ statuses, limit: 50 }),
    listReplies({ statuses, limit: 50 }),
    listTasks({ types: ["regenerate_draft", "comment_reply"], statuses: ["queued", "running"] }),
  ]);

  return (
    <div>
      <PageHeader
        title="Drafts"
        description="Posts and replies waiting for operator review. Nothing publishes without explicit approval."
        actions={<AutoRefresh enabled={activeTasks.length > 0} />}
      />

      <div className="mb-6 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((s) => (
          <Link
            key={s}
            href={s === "awaiting_review" ? "/drafts" : `/drafts?status=${s}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
              status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {s.replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      <Section title="Posts">
        {posts.length === 0 ? (
          <EmptyState>No posts in this state.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Rationale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.map((post: Post) => (
                <TableRow key={post.id}>
                  <TableCell className="max-w-64 truncate whitespace-nowrap">
                    <Link href={`/drafts/post/${post.id}`} className="hover:underline">
                      {post.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={post.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(post.createdAt, false)}</TableCell>
                  <TableCell className="text-muted-foreground">{post.metadata.model ?? "—"}</TableCell>
                  <TableCell className="max-w-96 min-w-64 truncate text-muted-foreground normal-case">
                    {truncate(post.metadata.rationale, 200)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Replies">
        {replies.length === 0 ? (
          <EmptyState>No replies in this state.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reply</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Rationale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {replies.map((reply: Reply) => (
                <TableRow key={reply.id}>
                  <TableCell className="max-w-64 truncate whitespace-nowrap">
                    <Link href={`/drafts/reply/${reply.id}`} className="hover:underline">
                      {firstLine(reply.body)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={reply.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(reply.createdAt, false)}</TableCell>
                  <TableCell className="text-muted-foreground">{reply.metadata.model ?? "—"}</TableCell>
                  <TableCell className="max-w-96 min-w-64 truncate text-muted-foreground normal-case">
                    {truncate(reply.metadata.rationale, 200)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
