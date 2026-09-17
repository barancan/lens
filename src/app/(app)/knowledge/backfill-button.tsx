"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { backfillEmbeddingsAction } from "../actions";

/** Backfills embeddings for nodes/chunks that don't have one yet (e.g. seeded questions). */
export function BackfillButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      const result = await backfillEmbeddingsAction();
      if (result.ok) {
        toast.success(`Backfilled embeddings for ${result.data?.updated ?? 0} row(s)`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={handleClick} disabled={pending}>
      {pending ? "Backfilling…" : "Backfill embeddings"}
    </Button>
  );
}
