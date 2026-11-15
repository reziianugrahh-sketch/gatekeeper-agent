import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createAgentHandler } from "../src/server.js";

/**
 * Vercel serverless entry for the Proof Gatekeeper agent.
 *
 * Register this exact path on the Agent Games dashboard:
 *   https://<deployment-host>/api/agent
 *
 * Body parsing is disabled so the platform's raw request bytes reach the
 * handler untouched — the HMAC signature is computed over them.
 */
export const config = {
  api: { bodyParser: false },
};

const env: NodeJS.ProcessEnv = {
  ...process.env,
  // The platform posts to the registered URL's exact path: /api/agent.
  AGENT_PATH: process.env.AGENT_PATH ?? "/api/agent",
  // Vercel runs functions with the project root as cwd; the circuit
  // artifacts ship in ./circuits (see vercel.json includeFiles).
  CIRCUIT_DIR: process.env.CIRCUIT_DIR ?? join(process.cwd(), "circuits"),
};

// Built once per function instance; warm invocations reuse the prover,
// the store connection state and the in-flight task map.
const handler = createAgentHandler(loadConfig(env));

export default handler;
