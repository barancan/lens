"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { OPENLABS_TAGS, OPENLABS_TOPICS } from "@/lib/integrations/openlabs/taxonomy";
import type { Settings } from "@/lib/settings/schema";

const POST_TYPES = ["discussion", "claim"] as const;
const MAX_TAGS = 5;

export function OpenLabsForm({ initial }: { initial: Settings["openlabs"] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [defaultPostType, setDefaultPostType] = React.useState(initial.defaultPostType);
  const [defaultTopic, setDefaultTopic] = React.useState(initial.defaultTopic);
  const [defaultTags, setDefaultTags] = React.useState<string[]>(initial.defaultTags);
  const [pollComments, setPollComments] = React.useState(initial.pollComments);
  const [maxPostsPerPoll, setMaxPostsPerPoll] = React.useState(initial.maxPostsPerPoll);
  const [maxIngestsPerPoll, setMaxIngestsPerPoll] = React.useState(initial.maxIngestsPerPoll);

  function toggleTag(tag: string) {
    setDefaultTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      if (prev.length >= MAX_TAGS) return prev;
      return [...prev, tag];
    });
  }

  function save() {
    startTransition(async () => {
      const result = await updateSettingsAction("openlabs", {
        defaultPostType,
        defaultTopic,
        defaultTags,
        pollComments,
        maxPostsPerPoll,
        maxIngestsPerPoll,
      });
      if (result.ok) {
        toast.success("OpenLabs settings saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ol-post-type">Default post type</Label>
        <select
          id="ol-post-type"
          value={defaultPostType}
          onChange={(e) => setDefaultPostType(e.target.value as (typeof POST_TYPES)[number])}
          className="h-8 w-48 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {POST_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <p className="text-sm text-muted-foreground">
          A discussion is an open question or synthesis. A claim is a hypothesis that automatically opens a public
          peer review on the platform and is expected to state how it could be falsified and to cite real sources.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ol-topic">Default topic</Label>
        <select
          id="ol-topic"
          value={defaultTopic}
          onChange={(e) => setDefaultTopic(e.target.value as (typeof OPENLABS_TOPICS)[number])}
          className="h-8 w-64 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {OPENLABS_TOPICS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Default tags (up to {MAX_TAGS})</Label>
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {OPENLABS_TAGS.map((tag) => {
            const checked = defaultTags.includes(tag);
            const disabled = !checked && defaultTags.length >= MAX_TAGS;
            return (
              <li key={tag}>
                <label className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleTag(tag)}
                    className="size-4 rounded border-input"
                  />
                  {tag}
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={pollComments} onCheckedChange={setPollComments} />
        Poll for comments
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ol-max-posts">Max posts per poll</Label>
          <Input
            id="ol-max-posts"
            type="number"
            min={1}
            max={50}
            value={maxPostsPerPoll}
            onChange={(e) => setMaxPostsPerPoll(Number(e.target.value))}
            className="w-32"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ol-max-ingests">Max ingests per poll</Label>
          <Input
            id="ol-max-ingests"
            type="number"
            min={1}
            max={20}
            value={maxIngestsPerPoll}
            onChange={(e) => setMaxIngestsPerPoll(Number(e.target.value))}
            className="w-32"
          />
        </div>
      </div>

      <div>
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
