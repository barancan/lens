/**
 * OpenLabs integration barrel. `import { OpenLabsPublisher, OpenLabsCommentSource }
 * from "@/lib/integrations/openlabs"` is the stable surface; the adapters
 * themselves live in `publisher.ts`/`comment-source.ts`, auth/HTTP/REST in
 * `auth.ts`/`http.ts`/`client.ts`.
 *
 * Enablement is env-only (`isOpenLabsConfigured()` in `config.ts`): `isEnabled()`
 * is synchronous and settings are DB-backed, so an adapter must never touch
 * settings or the DB directly.
 *
 * There is no API key. A one-time-onboarded PERMANENT `agentCredential`
 * (`OPENLABS_AGENT_CREDENTIAL`) mints short-lived session tokens per the
 * two-leg flow in `auth.ts`. Run `pnpm openlabs:onboard` once to obtain it,
 * and `pnpm openlabs:smoke` to verify a credential already in `.env.local`.
 */
export { OpenLabsPublisher } from "./publisher";
export { OpenLabsCommentSource } from "./comment-source";
export { isOpenLabsConfigured, openLabsConfig, openLabsPostUrl } from "./config";
export type { OpenLabsConfig } from "./config";
export { OpenLabsError } from "./errors";
export { OPENLABS_TOPICS, OPENLABS_TAGS, DEFAULT_TOPIC, sanitizeTags } from "./taxonomy";
export type { OpenLabsTopic, OpenLabsTag } from "./taxonomy";
