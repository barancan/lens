"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { removeFocusDirectiveAction, updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Settings } from "@/lib/settings/schema";
import type { ResearchSourceListing } from "@/lib/integrations/research/registry";

export function ProjectForm({
  initial,
  sources,
}: {
  initial: Settings["project"];
  sources: ResearchSourceListing[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [removing, startRemoveTransition] = React.useTransition();

  const [researchQuestion, setResearchQuestion] = React.useState(initial.researchQuestion);
  const [description, setDescription] = React.useState(initial.description);
  const [themesText, setThemesText] = React.useState(initial.themes.join("\n"));
  const [directives, setDirectives] = React.useState(initial.focusDirectives);
  const [newDirectivesText, setNewDirectivesText] = React.useState("");
  const [enabledSources, setEnabledSources] = React.useState<string[]>(initial.enabledSources);

  function toggleSource(id: string) {
    setEnabledSources((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  function removeDirective(index: number) {
    startRemoveTransition(async () => {
      const result = await removeFocusDirectiveAction(index);
      if (result.ok) {
        setDirectives((prev) => prev.filter((_, i) => i !== index));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function save() {
    startTransition(async () => {
      const newDirectives = newDirectivesText
        .split("\n")
        .map((d) => d.trim())
        .filter(Boolean);
      const result = await updateSettingsAction("project", {
        researchQuestion,
        description,
        themes: themesText.split("\n").map((t) => t.trim()).filter(Boolean),
        focusDirectives: [...directives, ...newDirectives],
        enabledSources,
      });
      if (result.ok) {
        toast.success("Project settings saved");
        setNewDirectivesText("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="research-question">Research question</Label>
        <Textarea id="research-question" rows={2} value={researchQuestion} onChange={(e) => setResearchQuestion(e.target.value)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="themes">Themes (one per line)</Label>
        <Textarea id="themes" rows={6} value={themesText} onChange={(e) => setThemesText(e.target.value)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Focus directives</Label>
        {directives.length === 0 ? (
          <p className="text-sm text-muted-foreground">None set.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {directives.map((d, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                <span>{d}</span>
                <Button type="button" variant="ghost" size="xs" disabled={removing} onClick={() => removeDirective(i)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          id="new-directives"
          rows={2}
          placeholder="Add new directives, one per line — saved when you save this card"
          value={newDirectivesText}
          onChange={(e) => setNewDirectivesText(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Enabled sources</Label>
        <ul className="flex flex-col gap-1.5">
          {sources.map((s) => (
            <li key={s.id} className={s.enabled ? "" : "opacity-50"}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!s.enabled}
                  checked={enabledSources.includes(s.id)}
                  onChange={() => toggleSource(s.id)}
                  className="size-4 rounded border-input"
                />
                <span className="font-medium">{s.id}</span>
                <span className="text-muted-foreground">{s.description}</span>
                {!s.enabled && <span className="text-muted-foreground">(not configured)</span>}
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
