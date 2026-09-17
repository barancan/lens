"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { sendChatMessageAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** Composer for a chat thread. Sends may take 10-60s, so it optimistically shows the user's message while pending. */
export function ChatComposer({ threadId }: { threadId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [text, setText] = React.useState("");
  const [optimistic, setOptimistic] = React.useState<string | null>(null);

  function send() {
    const message = text.trim();
    if (!message || pending) return;
    setOptimistic(message);
    setText("");
    startTransition(async () => {
      const result = await sendChatMessageAction(threadId, message);
      if (result.ok) {
        router.refresh();
      } else {
        toast.error(result.error);
        setText(message);
      }
      setOptimistic(null);
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {optimistic && (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">{optimistic}</div>
        </div>
      )}
      {pending && <p className="text-xs text-muted-foreground">LENS is working…</p>}
      <div className="flex gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={pending}
          placeholder="Ask LENS anything… (Enter to send, Shift+Enter for a new line)"
          rows={2}
          className="flex-1"
        />
        <Button onClick={send} disabled={pending || !text.trim()} className="self-end">
          Send
        </Button>
      </div>
    </div>
  );
}
