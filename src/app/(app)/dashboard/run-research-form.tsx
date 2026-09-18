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
        toast.success("Research task launched", {
          description: "It runs in the background. Progress and errors appear on the Runs page.",
          action: { label: "View runs", onClick: () => router.push("/runs") },
        });
        setObjective("");
        setUrls("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-3 rounded-lg border p-4">
      <div className="flex min-h-0 flex-1 flex-col">
        <label htmlFor="objective" className="mb-1 block text-xs font-medium text-muted-foreground">
          Objective (optional)
        </label>
        <Textarea
          id="objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="What should this research task focus on?"
          className="min-h-20 flex-1"
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
      <div className="mt-auto flex items-center gap-3">
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
