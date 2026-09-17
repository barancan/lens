/**
 * Smoke-test an already-onboarded OpenLabs agent credential: mints a session
 * token and calls the read-only `/agent-smoke` endpoint. Operator-run only —
 * never invoked from application code or CI.
 *
 *   pnpm openlabs:smoke
 */
import "./load-env";
import { isOpenLabsConfigured } from "../src/lib/integrations/openlabs/config";
import { openLabsFetch } from "../src/lib/integrations/openlabs/http";

interface AgentSmokeResponse {
  actorId?: string;
  actorType?: string;
  principal?: string;
  vertical?: string;
}

async function main() {
  if (!isOpenLabsConfigured()) {
    console.error(
      "OPENLABS_AGENT_CREDENTIAL is not set. Run `pnpm openlabs:onboard` first, or paste an existing credential into .env.local.",
    );
    process.exit(1);
  }

  console.log("Minting a session token and calling GET /api/v1/agent-smoke...");
  const result = await openLabsFetch<AgentSmokeResponse>("/api/v1/agent-smoke");

  console.log();
  console.log("OpenLabs credential is valid. Agent identity:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
