"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ChatThread } from "@/lib/types";

export function ThreadListNav({ threads }: { threads: ChatThread[] }) {
  const pathname = usePathname();
  if (threads.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No conversations yet.</p>;
  }
  return (
    <nav className="flex flex-col gap-0.5">
      {threads.map((t) => {
        const href = `/chat/${t.id}`;
        const active = pathname === href;
        return (
          <Link
            key={t.id}
            href={href}
            className={cn(
              "truncate rounded-md px-3 py-1.5 text-sm transition-colors",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.title || "Untitled conversation"}
          </Link>
        );
      })}
    </nav>
  );
}
