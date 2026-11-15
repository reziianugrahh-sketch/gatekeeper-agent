# Proof Gatekeeper agent

HTTP service for the zkVerify Agent Games **Proof Gatekeeper** event
(agentgames.zkverify.io). Receives HMAC-signed task envelopes, decides
APPROVE/REJECT with deterministic field checks, generates a Groth16 proof
of the decision with the official gatekeeper circuit (snarkjs), and returns
a signed response. Full protocol notes: `../PROTOCOL.md`.

## Layout

```
src/
  server.ts      transport: raw body -> HMAC verify -> route -> sign response
  gatekeeper.ts  per-task flow: claim (idempotent) -> decide -> prove -> persist
  checks.ts      parse + the 6 deterministic checks and reason codes
  encoding.ts    task field -> circuit field element conversions (taskId switch)
  prover.ts      snarkjs fullProve + local verify, budget-aware
  store.ts       TaskStore interface + persistent file store (JSON file)
  kv-store.ts    TaskStore on Upstash Redis REST (serverless state)
  hmac.ts        HMAC-SHA256 sign/verify (accepts UTF-8 or hex-decoded key)
  kurier.ts      optional zkVerify anchoring via Kurier (off the scoring path)
  config.ts      environment configuration
circuits/        official artifacts: gatekeeper.wasm, gatekeeper_final.zkey,
                 gatekeeper_vk.json (exported from the zkey)
api/agent.ts     Vercel serverless entry (register path /api/agent)
vercel.json      function config: 1024 MB, 60 s, circuits bundled
test/
  harness.mjs        end-to-end tests vs the real server (all trap types)
  probe-circuit.mjs  empirical probe of the circuit's semantics
```

## Run locally

```bash
npm install
npm run build
AGENT_GAMES_HMAC_SECRET=<any local test value> npm start   # listens on :8080/agent
npm test        # builds, spawns the server, replays all trap types (40 checks)
npm run probe   # re-runs the circuit semantics probe against circuits/
```

Secrets come only from the environment (see `.env.example`). The server
refuses to start without `AGENT_GAMES_HMAC_SECRET`.

## Go live (after dashboard registration)

1. Deploy so the service is reachable at a public HTTPS URL, standard port,
   full handler path (e.g. `https://<host>/agent`).
2. Dashboard: register the agent with that URL, enter Proof Gatekeeper.
3. Dashboard: **Rotate Secret**, set the revealed value as
   `AGENT_GAMES_HMAC_SECRET`, restart the service.
4. The platform runs signed preflight; the agent answers
   `{ ok: true, protocolVersion: "v1" }` and becomes active.
5. Burn practice tasks (<=10/hour) to settle the two unconfirmed wire
   details before the first scored round:
   - `TASK_ID_ENCODING` (default `keccak`) — how `task_id` maps to a field
     element; switchable by env var only.
   - the APPROVE reason code (`VALID_CONDITION`, in `src/checks.ts`).
6. Optional: set `KURIER_API_KEY` to anchor proofs on zkVerify mainnet.

## Hosting recommendation

Requirements: public HTTPS on a standard port, **no sleeping** (rules
§1.4 — free tiers that idle-sleep forfeit tasks), ~1–3 s CPU per proof,
8 tasks/day in the 17:30–03:30 WIB round windows, tiny persistent state.

**Recommended: Vercel (free Hobby tier), serverless.** It is proven in
this exact event — a participant runs a gatekeeper there with preflight
"Healthy, 579 ms" and 4/4 practice tasks correct. This repo is ready for
it:

- `api/agent.ts` exposes the same transport handler as a Vercel function
  (raw-body HMAC intact); register `https://<host>/api/agent`.
  `vercel.json` gives the function 1024 MB / 60 s and bundles `circuits/`.
- `src/kv-store.ts` is a KV-backed store (Upstash Redis REST, no SDK)
  behind the same `TaskStore` interface as the file store. It is used
  automatically when `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` are set (Vercel's Upstash integration
  injects them); otherwise the file store is used.
- Keep Kurier polling off the response path (already the design here:
  fire-and-forget after answering).

Exact go-live steps: `../DEPLOY.md`.

Alternatives considered: Render free tier sleeps after inactivity
(disqualifying); Cloudflare Workers free CPU limits are risky for
snarkjs proving; tunnels from a NATed VM (trycloudflare/localtunnel/bore)
were measured unreachable/403 from this VM's egress proxy, and Tailscale
Funnel would couple competition uptime to this VM staying up. A small
always-on VPS or Fly.io machine with a volume (this code runs as-is,
file store included) is the fallback if serverless proves awkward.
