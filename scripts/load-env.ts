/** Load .env* files exactly like Next.js does (including `\$` escaping). */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });
