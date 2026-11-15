import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_ID_ENCODINGS, type TaskIdEncoding } from "./encoding.js";

export interface Config {
  port: number;
  /** Registered handler path; the platform posts to this exact path. */
  agentPath: string;
  /** Platform-issued HMAC secret (dashboard -> Rotate Secret). Never hardcode. */
  hmacSecret: string;
  circuitDir: string;
  dataDir: string;
  /** Upstash Redis REST endpoint/token; when both are set the KV store replaces the file store. */
  upstashRestUrl: string | undefined;
  upstashRestToken: string | undefined;
  taskIdEncoding: TaskIdEncoding;
  kurierApiKey: string | undefined;
  proofBudgetMs: number;
  deadlineMarginMs: number;
  tlsKeyPath: string | undefined;
  tlsCertPath: string | undefined;
}

/** Project root (parent of dist/, where the compiled config lives). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const encoding = (env.TASK_ID_ENCODING ?? "keccak") as TaskIdEncoding;
  if (!TASK_ID_ENCODINGS.includes(encoding)) {
    throw new Error(
      `TASK_ID_ENCODING must be one of ${TASK_ID_ENCODINGS.join(", ")} (got "${encoding}")`,
    );
  }
  return {
    port: Number(env.PORT ?? 8080),
    agentPath: env.AGENT_PATH ?? "/agent",
    hmacSecret: env.AGENT_GAMES_HMAC_SECRET ?? "",
    circuitDir: env.CIRCUIT_DIR ?? join(ROOT, "circuits"),
    dataDir: env.DATA_DIR ?? join(ROOT, "data"),
    upstashRestUrl: env.UPSTASH_REDIS_REST_URL || undefined,
    upstashRestToken: env.UPSTASH_REDIS_REST_TOKEN || undefined,
    taskIdEncoding: encoding,
    kurierApiKey: env.KURIER_API_KEY || undefined,
    proofBudgetMs: Number(env.PROOF_BUDGET_MS ?? 45_000),
    deadlineMarginMs: Number(env.DEADLINE_MARGIN_MS ?? 3_000),
    tlsKeyPath: env.TLS_KEY_PATH || undefined,
    tlsCertPath: env.TLS_CERT_PATH || undefined,
  };
}
