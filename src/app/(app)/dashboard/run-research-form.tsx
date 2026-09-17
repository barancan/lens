"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { launchResearchAction } from "../actions";

/** Small client form for launching a research task from the dashboard. */
export function RunResearchForm() {
  const [objective, setObjective] = useState("");
  const [urls, setUrls] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const result = await launchResearchAction({
        objective: objective.trim() || undefined,
        urls,
      });
      if (result.ok) {
        toast.success(`Research task launched (${result.data?.taskId ?? "unknown"})`);
        setObjective("");
        setUrls("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-3 rounded-lg border p-4">
      <div>
        <label htmlFor="objective" className="mb-1 block text-xs font-medium text-muted-foreground">
          Objective (optional)
        </label>
        <Textarea
          id="objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="What should this research task focus on?"
        />
      </div>
      <div>
        <label htmlFor="urls" className="mb-1 block text-xs font-medium text-muted-foreground">
          URLs (optional, whitespace-separated, max 5)
        </label>
        <Textarea
          id="urls"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder="https://example.com/paper"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Launching…" : "Launch research"}
        </Button>
        <Link href="/runs" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          View runs
        </Link>
      </div>
    </form>
  );
}
