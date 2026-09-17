"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resumeTaskAction } from "../actions";

/** Resumes a failed or stale-running task. Used on the runs list and run detail pages. */
export function ResumeButton({ taskId }: { taskId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      const result = await resumeTaskAction(taskId);
      if (result.ok) {
        toast.success("Task resumed");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={handleClick} disabled={pending}>
      {pending ? "Resuming…" : "Resume"}
    </Button>
  );
}
