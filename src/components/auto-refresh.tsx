"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the current server page periodically while agent work is in progress. */
export function AutoRefresh({ enabled, intervalMs = 5000 }: { enabled: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);
  return enabled ? <span className="text-xs text-muted-foreground">auto-refreshing…</span> : null;
}
