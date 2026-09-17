"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WORKFLOW_MODEL_KEYS, type Settings } from "@/lib/settings/schema";

const PROVIDERS = ["anthropic", "openai", "bios", "local"] as const;

export function ModelsForm({ initial }: { initial: Settings["models"] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [models, setModels] = React.useState(initial);

  function save() {
    startTransition(async () => {
      const result = await updateSettingsAction("models", models);
      if (result.ok) {
        toast.success("Model settings saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        The <code>bios</code> and <code>local</code> providers are not implemented yet. The embedding model must stay
        1536-dimensional (openai text-embedding-3-small) — knowledge search will break with a different one.
      </p>
      <div className="flex flex-col gap-3">
        {WORKFLOW_MODEL_KEYS.map((key) => (
          <div key={key} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`model-provider-${key}`}>{key}</Label>
              <select
                id={`model-provider-${key}`}
                value={models[key].provider}
                onChange={(e) =>
                  setModels((prev) => ({ ...prev, [key]: { ...prev[key], provider: e.target.value as (typeof PROVIDERS)[number] } }))
                }
                className="h-8 w-36 rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`model-name-${key}`} className="sr-only">
                Model name
              </Label>
              <Input
                id={`model-name-${key}`}
                value={models[key].model}
                onChange={(e) => setModels((prev) => ({ ...prev, [key]: { ...prev[key], model: e.target.value } }))}
                className="w-56"
              />
            </div>
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
