"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { linkExternalPostAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Operator backfill for a published post that never got a platform id —
 * either the publish response was lost (timeout/abort) or the post predates
 * OpenLabs. Comment polling only visits posts with an `external_id`, so this
 * is what makes polling work for those posts.
 */
export function LinkExternalPostForm({ postId }: { postId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [value, setValue] = React.useState("");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await linkExternalPostAction(postId, value);
      if (result.ok) {
        toast.success("Linked to the external post");
        setValue("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-dashed p-4">
      <p className="text-sm text-muted-foreground">
        This post has no OpenLabs id on record. If it was already published there (the write may have gone through
        even if LENS never saw a response), paste its id or URL to link it — this is what lets comment polling find
        it.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="external-post-id">Post id or URL</Label>
        <Input
          id="external-post-id"
          placeholder="https://openlabs.bio.xyz/post/… or the bare id"
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div>
        <Button type="submit" size="sm" disabled={pending || !value.trim()}>
          Link post
        </Button>
      </div>
    </form>
  );
}
