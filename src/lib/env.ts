import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load proto/.env (kept out of git). Simple KEY=VALUE parser. */
export function loadEnv(): Record<string, string> {
  const envPath = resolve(__dirname, "../../proto/.env");
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch (e) {
    console.error(`[env] could not read ${envPath}:`, (e as Error).message);
  }
  // also fold in process.env overrides
  for (const k of ["GEMINI_API_KEY", "MAPS_API_KEY", "SERPAPI_KEY", "BROWSERLESS_URL", "BROWSERLESS_TOKEN"]) {
    if (process.env[k]) out[k] = process.env[k] as string;
  }
  return out;
}

export const ENV = loadEnv();
