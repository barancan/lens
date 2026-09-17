import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteThreadAction } from "@/app/(app)/actions";
import { EmptyState, formatDate } from "@/components/common";
import { Button } from "@/components/ui/button";
import { getThread, listMessages } from "@/lib/repo/chat";
import { AutoScroll } from "./auto-scroll";
import { ChatComposer } from "./chat-composer";

export default async function ChatThreadPage(props: PageProps<"/chat/[threadId]">) {
  const { threadId } = await props.params;
  const thread = await getThread(threadId);
  if (!thread) notFound();

  const messages = await listMessages(threadId, 200);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between gap-2 border-b pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{thread.title || "Untitled conversation"}</h1>
          <p className="text-xs text-muted-foreground">Started {formatDate(thread.createdAt)}</p>
        </div>
        <form action={deleteThreadAction.bind(null, threadId)}>
          <Button type="submit" variant="ghost" size="sm">
            Delete thread
          </Button>
        </form>
      </div>

      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState>No messages yet. Say hello.</EmptyState>
        ) : (
          <div className="flex flex-col gap-4 pb-2">
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[80%] rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap"
                      : "max-w-[80%] rounded-lg border bg-card px-3 py-2 text-sm whitespace-pre-wrap"
                  }
                >
                  <p>{m.content}</p>
                  {m.role === "assistant" && m.toolCalls.length > 0 && (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{m.toolCalls.length} tool calls</summary>
                      <ul className="mt-1 flex flex-col gap-1">
                        {m.toolCalls.map((tc, i) => (
                          <li key={i} className="rounded border p-1.5">
                            <div>
                              <span className="font-medium text-foreground">{tc.tool}</span> — {tc.ok ? "ok" : "failed"}{" "}
                              — {tc.durationMs}ms
                            </div>
                            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
                              input: {JSON.stringify(tc.input)}
                            </pre>
                            {tc.output !== undefined && (
                              <pre className="overflow-x-auto whitespace-pre-wrap">output: {JSON.stringify(tc.output)}</pre>
                            )}
                            {tc.error && <pre className="overflow-x-auto whitespace-pre-wrap text-destructive">error: {tc.error}</pre>}
                          </li>
                        ))}
                      </ul>
                      {m.runId && (
                        <Link href={`/runs/${m.runId}`} className="mt-1 inline-block hover:underline">
                          view run
                        </Link>
                      )}
                    </details>
                  )}
                </div>
              </div>
            ))}
            <AutoScroll dep={messages.length} />
          </div>
        )}
      </div>

      <div className="mt-3 border-t pt-3">
        <ChatComposer threadId={threadId} />
      </div>
    </div>
  );
}
