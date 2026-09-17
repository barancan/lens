"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { recomputeImpactAction } from "../actions";

/** Rescores impact across the knowledge base, stalest nodes first. */
export function RecomputeImpactButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      const result = await recomputeImpactAction();
      if (result.ok) {
        toast.success(`Rescored impact for ${result.data?.updated ?? 0} finding(s)`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={handleClick} disabled={pending}>
      {pending ? "Rescoring…" : "Recompute impact"}
    </Button>
  );
}
