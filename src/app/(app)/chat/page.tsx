const EXAMPLE_PROMPTS = [
  "Investigate cancer risk associated with OSK expression",
  "What is our current understanding of partial reprogramming in vivo?",
  "Draft a post about the strongest unresolved criticism",
  "Stop focusing on epigenetic clocks and investigate functional outcomes",
];

export default function ChatIndexPage() {
  return (
    <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-lg font-semibold">Talk to LENS</h1>
      <p className="text-sm text-muted-foreground">
        Ask about accumulated knowledge, request new research, or ask LENS to draft something. LENS uses its tools
        rather than relying on memory, so answers stay grounded in stored evidence. Select a conversation on the
        left, or start a new one.
      </p>
      <div className="w-full text-left">
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Example prompts</p>
        <ul className="flex flex-col gap-1.5 text-sm">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt} className="rounded-md border px-3 py-2 text-muted-foreground">
              {prompt}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
