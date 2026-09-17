"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Settings } from "@/lib/settings/schema";

const RESEARCH_DEPTHS = ["shallow", "standard", "deep"] as const;

export function ResearchAgentForm({ initial }: { initial: Settings["research_agent"] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [systemPrompt, setSystemPrompt] = React.useState(initial.systemPrompt);
  const [voice, setVoice] = React.useState(initial.voice);
  const [writingStyle, setWritingStyle] = React.useState(initial.writingStyle);
  const [scientificConservatism, setScientificConservatism] = React.useState(initial.scientificConservatism);
  const [sourceRequirements, setSourceRequirements] = React.useState(initial.sourceRequirements);
  const [citationRequirements, setCitationRequirements] = React.useState(initial.citationRequirements);
  const [prohibitedBehaviorText, setProhibitedBehaviorText] = React.useState(initial.prohibitedBehavior.join("\n"));
  const [postLengthWords, setPostLengthWords] = React.useState(initial.postLengthWords);
  const [researchDepth, setResearchDepth] = React.useState(initial.researchDepth);

  function save() {
    startTransition(async () => {
      const result = await updateSettingsAction("research_agent", {
        systemPrompt,
        voice,
        writingStyle,
        scientificConservatism,
        sourceRequirements,
        citationRequirements,
        prohibitedBehavior: prohibitedBehaviorText.split("\n").map((l) => l.trim()).filter(Boolean),
        postLengthWords,
        researchDepth,
      });
      if (result.ok) {
        toast.success("Research/post agent settings saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-system-prompt">System prompt</Label>
        <Textarea id="ra-system-prompt" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-voice">Voice</Label>
        <Input id="ra-voice" value={voice} onChange={(e) => setVoice(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-writing-style">Writing style</Label>
        <Textarea id="ra-writing-style" rows={2} value={writingStyle} onChange={(e) => setWritingStyle(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-conservatism">Scientific conservatism (1 = speculative, 5 = maximally conservative)</Label>
        <Input
          id="ra-conservatism"
          type="number"
          min={1}
          max={5}
          value={scientificConservatism}
          onChange={(e) => setScientificConservatism(Number(e.target.value))}
          className="w-24"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-source-requirements">Source requirements</Label>
        <Textarea
          id="ra-source-requirements"
          rows={3}
          value={sourceRequirements}
          onChange={(e) => setSourceRequirements(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-citation-requirements">Citation requirements</Label>
        <Textarea
          id="ra-citation-requirements"
          rows={2}
          value={citationRequirements}
          onChange={(e) => setCitationRequirements(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-prohibited">Prohibited behavior (one per line)</Label>
        <Textarea
          id="ra-prohibited"
          rows={5}
          value={prohibitedBehaviorText}
          onChange={(e) => setProhibitedBehaviorText(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-post-length">Post length (words)</Label>
        <Input
          id="ra-post-length"
          type="number"
          min={50}
          max={2000}
          value={postLengthWords}
          onChange={(e) => setPostLengthWords(Number(e.target.value))}
          className="w-28"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ra-depth">Research depth</Label>
        <select
          id="ra-depth"
          value={researchDepth}
          onChange={(e) => setResearchDepth(e.target.value as (typeof RESEARCH_DEPTHS)[number])}
          className="h-8 w-40 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {RESEARCH_DEPTHS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
