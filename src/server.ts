import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { loadConfig, type Config } from "./config.js";
import { Gatekeeper } from "./gatekeeper.js";
import { SIGNATURE_HEADER, candidateKeys, sign, verifyAnyKey } from "./hmac.js";
import { KvStore } from "./kv-store.js";
import { submitProofToKurier } from "./kurier.js";
import { Prover, shutdownProver } from "./prover.js";
import { Store, type TaskStore } from "./store.js";

/**
 * Proof Gatekeeper agent endpoint.
 *
 * Transport only: read the raw body, verify the HMAC signature BEFORE
 * parsing, route preflight vs task, sign every response. All decision
 * logic lives in gatekeeper.ts / checks.ts. TLS is normally terminated by
 * the hosting platform; set TLS_KEY_PATH/TLS_CERT_PATH to serve HTTPS
 * directly.
 */

/** KV store when Upstash REST env is configured, else the local file store. */
export function createTaskStore(config: Config): TaskStore {
  if (config.upstashRestUrl && config.upstashRestToken) {
    return new KvStore(config.upstashRestUrl, config.upstashRestToken);
  }
  return new Store(config.dataDir);
}

export type AgentHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The transport handler on its own (no listening socket), for embedding
 * in a serverless function (see api/agent.ts) or a plain HTTP server.
 * State (keys, Gatekeeper, prover, store) is built once per call, so a
 * warm serverless instance reuses it across invocations.
 */
export function createAgentHandler(config: Config): AgentHandler {
  const keys = candidateKeys(config.hmacSecret);
  const primaryKey = keys[0];

  const gatekeeper = new Gatekeeper({
    store: createTaskStore(config),
    prover: new Prover(config.circuitDir),
    taskIdEncoding: config.taskIdEncoding,
    proofBudgetMs: config.proofBudgetMs,
    deadlineMarginMs: config.deadlineMarginMs,
    onAnswered: config.kurierApiKey
      ? (answered) => {
          if (answered.proof && answered.publicSignals) {
            void submitProofToKurier(
              config.kurierApiKey as string,
              answered.proof,
              answered.publicSignals,
            ).then((r) => console.log(`[kurier] task=${answered.taskId}: ${r}`));
          }
        }
      : undefined,
  });

  function sendSigned(res: ServerResponse, status: number, body: string, key: Buffer): void {
    res.writeHead(status, {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: sign(key, body),
    });
    res.end(body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendSigned(res, 200, JSON.stringify({ ok: true, service: "proof-gatekeeper-agent" }), primaryKey);
      return;
    }
    if (req.method !== "POST" || url.pathname !== config.agentPath) {
      sendSigned(res, 404, JSON.stringify({ error: "not_found" }), primaryKey);
      return;
    }

    const rawBody = await readRawBody(req);
    // Signature first, over the raw bytes, before any parsing or work.
    const header = req.headers[SIGNATURE_HEADER];
    const matchedKey = verifyAnyKey(keys, rawBody, Array.isArray(header) ? header[0] : header);
    if (!matchedKey) {
      sendSigned(res, 401, JSON.stringify({ error: "invalid_signature" }), primaryKey);
      return;
    }

    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      sendSigned(res, 400, JSON.stringify({ error: "invalid_json" }), matchedKey);
      return;
    }

    if (envelope.type === "agent-games.preflight.v1") {
      sendSigned(res, 200, JSON.stringify({ ok: true, protocolVersion: "v1" }), matchedKey);
      return;
    }
    if (envelope.type === "agent-games.proof-gatekeeper.v1") {
      const body = await gatekeeper.handle(envelope);
      sendSigned(res, 200, body, matchedKey);
      return;
    }
    sendSigned(res, 400, JSON.stringify({ error: "unknown_envelope_type" }), matchedKey);
  }

  const listener: AgentHandler = (req, res) => {
    handle(req, res).catch((e) => {
      console.error(`[server] unhandled error: ${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) {
        sendSigned(res, 500, JSON.stringify({ error: "internal" }), primaryKey);
      } else {
        res.end();
      }
    });
  };

  return listener;
}

export function createAgentServer(config: Config): { server: Server; stop: () => Promise<void> } {
  const listener = createAgentHandler(config);

  const server: Server =
    config.tlsKeyPath && config.tlsCertPath
      ? createHttpsServer(
          { key: readFileSync(config.tlsKeyPath), cert: readFileSync(config.tlsCertPath) },
          listener,
        )
      : createHttpServer(listener);

  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  return { server, stop };
}

function readRawBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function main(): void {
  const config = loadConfig();
  if (!config.hmacSecret) {
    console.error(
      "AGENT_GAMES_HMAC_SECRET is not set. Get it from the platform dashboard (Rotate Secret) and set it in the environment. Refusing to start.",
    );
    process.exit(1);
  }
  const { server, stop } = createAgentServer(config);
  server.listen(config.port, () => {
    console.log(
      `[server] proof-gatekeeper-agent listening on :${config.port}${config.agentPath} (taskIdEncoding=${config.taskIdEncoding}, kurier=${config.kurierApiKey ? "on" : "off"})`,
    );
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void stop()
        .then(shutdownProver)
        .finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
