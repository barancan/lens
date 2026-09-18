"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { launchDiscoveryAction } from "../actions";

/**
 * Launches a discovery task: search the community platform, triage what it
 * finds against the research question, and record new gaps as open questions.
 */
export function DiscoverForm({ configured }: { configured: boolean }) {
  const [queries, setQueries] = useState("");
  const [topic, setTopic] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const result = await launchDiscoveryAction({ queries, topic });
      if (result.ok) {
        toast.success("Discovery task launched", {
          description: "New questions appear in Knowledge once it finishes; queue any worth drilling into.",
          action: { label: "View runs", onClick: () => router.push("/runs") },
        });
        setQueries("");
        setTopic("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-3 rounded-lg border p-4">
      {!configured ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          No community platform is configured, so a run would find nothing. Set{" "}
          <code className="font-mono">OPENLABS_AGENT_CREDENTIAL</code> to enable this.
        </p>
      ) : null}

      <div>
        <label htmlFor="queries" className="mb-1 block text-xs font-medium text-muted-foreground">
          Search terms (optional, one per line, max 4)
        </label>
        <Textarea
          id="queries"
          value={queries}
          onChange={(e) => setQueries(e.target.value)}
          placeholder={"partial reprogramming\nteratoma risk"}
          rows={3}
        />
      </div>

      <div>
        <label htmlFor="topic" className="mb-1 block text-xs font-medium text-muted-foreground">
          Topic slug (optional)
        </label>
        <Input
          id="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="biology-life-sciences"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Searching…" : "Discover"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Community posts raise questions — they never become evidence.
        </span>
      </div>
    </form>
  );
}
