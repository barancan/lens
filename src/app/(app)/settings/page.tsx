import { PageHeader } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listResearchSources } from "@/lib/integrations/research/registry";
import { getAllSettings } from "@/lib/settings/service";
import { ChatAgentForm } from "./chat-agent-form";
import { CommentAgentForm } from "./comment-agent-form";
import { LimitsForm } from "./limits-form";
import { ModelsForm } from "./models-form";
import { ProjectForm } from "./project-form";
import { ResearchAgentForm } from "./research-agent-form";

export default async function SettingsPage() {
  const settings = await getAllSettings();
  const sources = listResearchSources();

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
      </div>
    </div>
  );
}
