"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Settings } from "@/lib/settings/schema";

const FIELDS: { key: keyof Settings["limits"]; label: string; min: number; max: number }[] = [
  { key: "maxQueriesPerRun", label: "Max queries per run", min: 1, max: 20 },
  { key: "maxResultsPerQuery", label: "Max results per query", min: 1, max: 50 },
  { key: "maxSourcesPerRun", label: "Max sources per run", min: 1, max: 30 },
  { key: "maxClaimsPerSource", label: "Max claims per source", min: 1, max: 20 },
  { key: "maxToolCalls", label: "Max tool calls", min: 1, max: 200 },
  { key: "maxFollowUpResearch", label: "Max follow-up research", min: 0, max: 5 },
  { key: "maxChatToolRounds", label: "Max chat tool rounds", min: 1, max: 20 },
  { key: "maxSourceChars", label: "Max source characters", min: 2000, max: 200000 },
];

export function LimitsForm({ initial }: { initial: Settings["limits"] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [limits, setLimits] = React.useState(initial);

  function save() {
    startTransition(async () => {
      const result = await updateSettingsAction("limits", limits);
      if (result.ok) {
        toast.success("Limits saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`limit-${f.key}`}>{f.label}</Label>
            <Input
              id={`limit-${f.key}`}
              type="number"
              min={f.min}
              max={f.max}
              value={limits[f.key]}
              onChange={(e) => setLimits((prev) => ({ ...prev, [f.key]: Number(e.target.value) }))}
              className="w-32"
            />
          </div>
        ))}
      </div>
      <div>
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
