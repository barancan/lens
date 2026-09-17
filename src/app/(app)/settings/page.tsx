import { PageHeader } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isOpenLabsConfigured } from "@/lib/integrations/openlabs";
import { listResearchSources } from "@/lib/integrations/research/registry";
import { getAllSettings } from "@/lib/settings/service";
import { ChatAgentForm } from "./chat-agent-form";
import { CommentAgentForm } from "./comment-agent-form";
import { LimitsForm } from "./limits-form";
import { ModelsForm } from "./models-form";
import { OpenLabsForm } from "./openlabs-form";
import { ProjectForm } from "./project-form";
import { ResearchAgentForm } from "./research-agent-form";
import { CurrentSchedule, ScheduleForm } from "./schedule-form";
import vercelConfig from "../../../../vercel.json";

export default async function SettingsPage() {
  const settings = await getAllSettings();
  const sources = listResearchSources();
  const openLabsConfigured = isOpenLabsConfigured();
  // Read straight from the committed config, so the panel shows what is
  // actually deployed rather than what the setting wishes were deployed.
  const deployedCrons = vercelConfig.crons ?? [];

  return (
    <div>
      <PageHeader
        title="Settings"
        description="API keys and credentials are configured via environment variables and are never shown here."
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Project</CardTitle>
          </CardHeader>
          <CardContent>
            <ProjectForm key={JSON.stringify(settings.project)} initial={settings.project} sources={sources} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Research / post agent</CardTitle>
          </CardHeader>
          <CardContent>
            <ResearchAgentForm key={JSON.stringify(settings.research_agent)} initial={settings.research_agent} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Comment agent</CardTitle>
          </CardHeader>
          <CardContent>
            <CommentAgentForm key={JSON.stringify(settings.comment_agent)} initial={settings.comment_agent} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chat agent</CardTitle>
          </CardHeader>
          <CardContent>
            <ChatAgentForm key={JSON.stringify(settings.chat_agent)} initial={settings.chat_agent} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Models</CardTitle>
          </CardHeader>
          <CardContent>
            <ModelsForm key={JSON.stringify(settings.models)} initial={settings.models} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Limits</CardTitle>
          </CardHeader>
          <CardContent>
            <LimitsForm key={JSON.stringify(settings.limits)} initial={settings.limits} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ScheduleForm key={JSON.stringify(settings.schedule)} initial={settings.schedule} />
            <div className="rounded-md border border-dashed px-3 py-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Currently deployed</p>
              <CurrentSchedule timeZone={settings.schedule.timezone} crons={deployedCrons} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>OpenLabs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!openLabsConfigured && (
              <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                OpenLabs is not configured. These settings will apply once it is. Run{" "}
                <code className="font-mono">pnpm openlabs:onboard</code> and set{" "}
                <code className="font-mono">OPENLABS_AGENT_CREDENTIAL</code> to enable publishing and comment
                polling.
              </p>
            )}
            <OpenLabsForm key={JSON.stringify(settings.openlabs)} initial={settings.openlabs} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
