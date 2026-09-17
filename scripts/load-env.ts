/** Load .env* files exactly like Next.js does (including `\$` escaping). */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });
