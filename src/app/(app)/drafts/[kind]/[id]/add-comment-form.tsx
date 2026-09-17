"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addCommentAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Manual stand-in for platform comment ingestion: record a comment received on a published post. */
export function AddCommentForm({ postId }: { postId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [author, setAuthor] = React.useState("");
  const [body, setBody] = React.useState("");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await addCommentAction({ postId, author, body });
      if (result.ok) {
        toast.success("Comment recorded — reply workflow started");
        setAuthor("");
        setBody("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="comment-author">Author</Label>
        <Input id="comment-author" required value={author} onChange={(e) => setAuthor(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="comment-body">Comment</Label>
        <Textarea id="comment-body" rows={3} required value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          Add comment
        </Button>
      </div>
    </form>
  );
}
