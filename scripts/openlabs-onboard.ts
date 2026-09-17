/**
 * One-time OpenLabs agent registration. Operator-run only — never call this
 * from application code, CI, or an agent; it mints a PERMANENT account key.
 *
 *   pnpm openlabs:onboard --display-name "LENS" --description "..."
 *   pnpm openlabs:onboard --dry-run --display-name "LENS" --description "..."
 *
 * Refuses to run if OPENLABS_AGENT_CREDENTIAL is already set (the platform
 * forbids duplicate accounts and credentials cannot be recovered or rotated
 * through this script) — pass --force only if you are deliberately replacing it.
 */
import "./load-env";
import { readEnv } from "../src/lib/env";
import { fetchWithTimeout, userAgent } from "../src/lib/integrations/research/http";

const ID_API_URL = readEnv("OPENLABS_ID_API_URL") || "https://api.id.bio.xyz";
const API_URL = readEnv("OPENLABS_API_URL") || "https://api.openlabs.bio.xyz";

interface Args {
  displayName: string;
  description: string;
  externalAgentRef: string;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return {
    displayName: flags["display-name"] || "LENS",
    description:
      flags["description"] ||
      "Research agent operated by a human; publishes evidence-backed posts and replies on behalf of LENS.",
    externalAgentRef: flags["external-ref"] || `lens-${Date.now()}`,
    dryRun,
    force,
  };
}

interface AgentCreateResponse {
  data?: { agentCredential?: string };
}
interface AgentOnboardResponse {
  data?: { externalAgentRef?: string; id?: string; privyUserId?: string };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (readEnv("OPENLABS_AGENT_CREDENTIAL") && !args.force) {
    console.error(
      "OPENLABS_AGENT_CREDENTIAL is already set. Refusing to onboard a second agent identity — " +
        "the platform forbids duplicate accounts and credentials cannot be recovered. Pass --force to override.",
    );
    process.exit(1);
  }

  const createPayload = {
    externalAgentRef: args.externalAgentRef,
    displayName: args.displayName,
    description: args.description,
  };

  if (args.dryRun) {
    console.log("Dry run — no network calls made.\n");
    console.log("Step 1: POST", `${ID_API_URL}/api/v1/auth/agent/create`);
    console.log(JSON.stringify(createPayload, null, 2));
    console.log("\nStep 2: POST", `${API_URL}/api/v1/auth/agent/onboard`);
    console.log(
      JSON.stringify(
        { agentCredential: "<from step 1>", displayName: args.displayName, description: args.description },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Creating OpenLabs agent identity (externalAgentRef=${args.externalAgentRef})...`);
  const createRes = await fetchWithTimeout(`${ID_API_URL}/api/v1/auth/agent/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify(createPayload),
  });
  if (!createRes.ok) {
    console.error(`agent/create failed: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const created = (await createRes.json()) as AgentCreateResponse;
  const agentCredential = created.data?.agentCredential;
  if (!agentCredential) {
    console.error("agent/create response did not include a credential:", JSON.stringify(created));
    process.exit(1);
  }

  console.log("Onboarding profile...");
  const onboardRes = await fetchWithTimeout(`${API_URL}/api/v1/auth/agent/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify({ agentCredential, displayName: args.displayName, description: args.description }),
  });
  if (!onboardRes.ok) {
    console.error(`agent/onboard failed: ${onboardRes.status} ${await onboardRes.text()}`);
    console.error("Your agentCredential (from step 1) is still valid — store it and retry onboarding, do not discard it:");
    console.error(agentCredential);
    process.exit(1);
  }
  const onboarded = (await onboardRes.json()) as AgentOnboardResponse;

  console.log();
  console.log("=".repeat(72));
  console.log("SUCCESS — store this credential in a password manager now.");
  console.log("It is a PERMANENT account key: it cannot be recovered or rotated");
  console.log("through this script, and duplicate accounts are not allowed.");
  console.log("=".repeat(72));
  console.log();
  console.log("agentCredential:");
  console.log(agentCredential);
  console.log();
  console.log("For .env.local:");
  console.log(`OPENLABS_AGENT_CREDENTIAL=${agentCredential}`);
  console.log();
  console.log("Note: the Vercel dashboard env var UI takes the raw value directly — paste it there too.");
  console.log();
  console.log(`Onboarded: externalAgentRef=${onboarded.data?.externalAgentRef ?? args.externalAgentRef}, id=${onboarded.data?.id ?? "?"}`);
  console.log(
    `The public handle is derived by the platform from displayName ("${args.displayName}", 3-30 chars, ` +
      "lowercase/digits/underscore; collisions get a numeric suffix) — check the profile on the site for the final handle.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
