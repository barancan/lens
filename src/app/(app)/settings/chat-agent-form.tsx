"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Settings } from "@/lib/settings/schema";

export function ChatAgentForm({ initial }: { initial: Settings["chat_agent"] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [systemPrompt, setSystemPrompt] = React.useState(initial.systemPrompt);

  function save() {
    startTransition(async () => {
      const result = await updateSettingsAction("chat_agent", { systemPrompt });
      if (result.ok) {
        toast.success("Chat agent settings saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="chat-system-prompt">System prompt</Label>
        <Textarea id="chat-system-prompt" rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      </div>
      <div>
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
