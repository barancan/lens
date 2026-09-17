"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateSettingsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeSchedule, formatTime, isValidTimeZone, parseTime, utcToLocalTime, type LocalTime } from "@/lib/schedule";
import type { Settings } from "@/lib/settings/schema";

/** The detected zone never changes within a session, so there is nothing to subscribe to. */
function subscribeNever(): () => void {
  return () => {};
}

function detectTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

const CRONS = [
  { key: "research", path: "/api/cron/research", label: "Research run" },
  { key: "comments", path: "/api/cron/comments", label: "Comment polling" },
] as const;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy — select the text instead.");
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * Turns the times the operator thinks in into the UTC cron expressions
 * `vercel.json` needs.
 *
 * Deliberately does not pretend to change the schedule: Vercel reads
 * `vercel.json` at deploy time, so this generates what to commit and shows what
 * daylight saving will do to it. What it removes is the arithmetic and the
 * twice-yearly surprise.
 */
export function ScheduleForm({ initial }: { initial: Settings["schedule"] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [timezone, setTimezone] = React.useState(initial.timezone);
  const [times, setTimes] = React.useState<Record<string, string>>({
    research: formatTime(initial.research),
    comments: formatTime(initial.comments),
  });
  // Read from the browser, never the server: the server's zone is not the
  // operator's, and rendering it would also mismatch on hydration.
  const detected = React.useSyncExternalStore(subscribeNever, detectTimeZone, () => null);

  const zoneValid = isValidTimeZone(timezone);
  const parsed: Record<string, LocalTime | null> = {
    research: parseTime(times.research),
    comments: parseTime(times.comments),
  };
  const allValid = zoneValid && Object.values(parsed).every(Boolean);

  function save() {
    if (!allValid) return;
    startTransition(async () => {
      const result = await updateSettingsAction("schedule", {
        timezone,
        research: parsed.research,
        comments: parsed.comments,
      });
      if (result.ok) {
        toast.success("Schedule saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Vercel runs crons from <code className="font-mono">vercel.json</code>, always in UTC, and reads that file at
        deploy time — so this cannot change the live schedule on its own. Set the times you want in your own timezone
        and commit the expressions below.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="timezone">Your timezone</Label>
          <Input
            id="timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-60"
            aria-invalid={!zoneValid}
          />
        </div>
        {detected && detected !== timezone ? (
          <Button size="sm" variant="outline" onClick={() => setTimezone(detected)}>
            Use {detected}
          </Button>
        ) : null}
        {detected === timezone ? (
          <span className="pb-2 text-xs text-muted-foreground">Detected from your browser</span>
        ) : null}
      </div>
      {!zoneValid ? <p className="text-sm text-destructive">Not a known IANA timezone, e.g. Europe/Berlin.</p> : null}

      <div className="flex flex-col gap-4">
        {CRONS.map((cron) => {
          const local = parsed[cron.key];
          return (
            <div key={cron.key} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`time-${cron.key}`}>{cron.label}</Label>
                  <Input
                    id={`time-${cron.key}`}
                    type="time"
                    value={times[cron.key]}
                    onChange={(e) => setTimes((t) => ({ ...t, [cron.key]: e.target.value }))}
                    className="w-32"
                    aria-invalid={!local}
                  />
                </div>
                <code className="pb-2 font-mono text-xs text-muted-foreground">{cron.path}</code>
              </div>

              {local && zoneValid ? <CronPreview timeZone={timezone} local={local} path={cron.path} /> : null}
            </div>
          );
        })}
      </div>

      <div>
        <Button onClick={save} disabled={pending || !allValid}>
          {pending ? "Saving…" : "Save schedule"}
        </Button>
      </div>
    </div>
  );
}

function CronPreview({ timeZone, local, path }: { timeZone: string; local: LocalTime; path: string }) {
  // Recomputed per render rather than memoised: it is cheap, and pinning "now"
  // would make the DST warning go stale in a long-lived tab.
  const schedule = describeSchedule(timeZone, local);
  const line = `{ "path": "${path}", "schedule": "${schedule.cron}" }`;

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{line}</code>
        <CopyButton text={line} />
      </div>
      <p className="text-xs text-muted-foreground">
        {formatTime(local)} {schedule.abbreviation} = {formatTime(schedule.utc)} UTC
      </p>

      {schedule.drift ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <strong>Daylight saving:</strong> on{" "}
          {schedule.drift.at.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} the clocks
          change and this expression starts firing at {formatTime(schedule.drift.localAfter)}{" "}
          {schedule.drift.abbreviationAfter} instead. To keep it at {formatTime(local)}, change the schedule to{" "}
          <code className="font-mono">{schedule.drift.cronAfter}</code> then.
        </p>
      ) : null}
    </div>
  );
}

/** What the committed `vercel.json` currently means in the operator's timezone. */
export function CurrentSchedule({ timeZone, crons }: { timeZone: string; crons: { path: string; schedule: string }[] }) {
  if (!isValidTimeZone(timeZone)) return null;
  return (
    <ul className="text-xs text-muted-foreground">
      {crons.map((c) => {
        const [minute, hour] = c.schedule.split(" ");
        const utc = { hour: Number(hour), minute: Number(minute) };
        if (!Number.isFinite(utc.hour) || !Number.isFinite(utc.minute)) return null;
        return (
          <li key={c.path}>
            <code className="font-mono">{c.path}</code> — deployed as{" "}
            <code className="font-mono">{c.schedule}</code>, which is {formatTime(utcToLocalTime(timeZone, utc))} in{" "}
            {timeZone}
          </li>
        );
      })}
    </ul>
  );
}
