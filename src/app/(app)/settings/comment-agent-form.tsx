"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Settings } from "@/lib/settings/schema";

const RESEARCH_BEFORE_REPLY = ["never", "when_needed", "always"] as const;

export function CommentAgentForm({ initial }: { initial: Settings["comment_agent"] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [systemPrompt, setSystemPrompt] = React.useState(initial.systemPrompt);
  const [voice, setVoice] = React.useState(initial.voice);
  const [tone, setTone] = React.useState(initial.tone);
  const [assertiveness, setAssertiveness] = React.useState(initial.assertiveness);
  const [researchBeforeReply, setResearchBeforeReply] = React.useState(initial.researchBeforeReply);
  const [citationBehavior, setCitationBehavior] = React.useState(initial.citationBehavior);
  const [prohibitedBehaviorText, setProhibitedBehaviorText] = React.useState(initial.prohibitedBehavior.join("\n"));
  const [maxResponseWords, setMaxResponseWords] = React.useState(initial.maxResponseWords);
  const [replyToNoise, setReplyToNoise] = React.useState(initial.replyToNoise);

  function save() {
    startTransition(async () => {
      const result = await updateSettingsAction("comment_agent", {
        systemPrompt,
        voice,
        tone,
        assertiveness,
        researchBeforeReply,
        citationBehavior,
        prohibitedBehavior: prohibitedBehaviorText.split("\n").map((l) => l.trim()).filter(Boolean),
        maxResponseWords,
        replyToNoise,
      });
      if (result.ok) {
        toast.success("Comment agent settings saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-system-prompt">System prompt</Label>
        <Textarea id="ca-system-prompt" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-voice">Voice</Label>
        <Input id="ca-voice" value={voice} onChange={(e) => setVoice(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-tone">Tone</Label>
        <Input id="ca-tone" value={tone} onChange={(e) => setTone(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-assertiveness">Assertiveness (1 = deferential, 5 = direct)</Label>
        <Input
          id="ca-assertiveness"
          type="number"
          min={1}
          max={5}
          value={assertiveness}
          onChange={(e) => setAssertiveness(Number(e.target.value))}
          className="w-24"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-research-before-reply">Research before reply</Label>
        <select
          id="ca-research-before-reply"
          value={researchBeforeReply}
          onChange={(e) => setResearchBeforeReply(e.target.value as (typeof RESEARCH_BEFORE_REPLY)[number])}
          className="h-8 w-48 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {RESEARCH_BEFORE_REPLY.map((v) => (
            <option key={v} value={v}>
              {v.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-citation-behavior">Citation behavior</Label>
        <Textarea
          id="ca-citation-behavior"
          rows={2}
          value={citationBehavior}
          onChange={(e) => setCitationBehavior(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-prohibited">Prohibited behavior (one per line)</Label>
        <Textarea
          id="ca-prohibited"
          rows={5}
          value={prohibitedBehaviorText}
          onChange={(e) => setProhibitedBehaviorText(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ca-max-response-words">Max response words</Label>
        <Input
          id="ca-max-response-words"
          type="number"
          min={20}
          max={1000}
          value={maxResponseWords}
          onChange={(e) => setMaxResponseWords(Number(e.target.value))}
          className="w-28"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={replyToNoise} onCheckedChange={setReplyToNoise} />
        Reply to noise
      </label>
      <div>
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
