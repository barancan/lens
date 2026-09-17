import { createThreadAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { listThreads } from "@/lib/repo/chat";
import { ThreadListNav } from "./thread-list-nav";

export default async function ChatLayout({ children }: LayoutProps<"/chat">) {
  const threads = await listThreads(50);

  return (
    <div className="flex h-[calc(100vh-3rem)] gap-6 md:h-[calc(100vh-4rem)]">
      <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r pr-4">
        <form action={createThreadAction}>
          <Button type="submit" size="sm" className="w-full">
            New chat
          </Button>
        </form>
        <Separator />
        <ThreadListNav threads={threads} />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
