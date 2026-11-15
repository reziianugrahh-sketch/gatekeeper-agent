/**
 * Optional zkVerify anchoring via the Kurier REST API.
 *
 * Off the scoring path: the scored artifact is the proof inside the signed
 * task response (see ../PROTOCOL.md §7). When KURIER_API_KEY is configured,
 * each answered task's proof is additionally submitted to zkVerify and
 * polled until Finalized, purely as an on-chain audit trail. Never throws.
 */

const KURIER_API_URL = "https://api.kurier.xyz/api/v1";
/** Registered gatekeeper verification-key hash on zkVerify mainnet. */
export const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function submitProofToKurier(
  apiKey: string,
  proof: unknown,
  publicSignals: string[],
  timeoutMs = 50_000,
): Promise<string> {
  try {
    const res = await fetch(`${KURIER_API_URL}/submit-proof/${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofType: "groth16",
        vkRegistered: true,
        proofOptions: { library: "snarkjs", curve: "bn128" },
        proofData: { proof, publicSignals, vk: GATEKEEPER_VK_HASH },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `submit failed: HTTP ${res.status}`;
    const job = (await res.json()) as { jobId?: string; id?: string; status?: string };
    const jobId = job.jobId ?? job.id;
    if (!jobId) return job.status ?? "Submitted (no job id returned)";

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(3_000);
      try {
        const sres = await fetch(`${KURIER_API_URL}/job/${jobId}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!sres.ok) continue;
        const sjob = (await sres.json()) as { status?: string };
        if (sjob.status === "Finalized") return `Finalized (job ${jobId})`;
        if (sjob.status === "Failed" || sjob.status === "Error") {
          return `${sjob.status} (job ${jobId})`;
        }
      } catch {
        // transient poll error; keep waiting until the timeout
      }
    }
    return `not finalized within ${timeoutMs} ms (job ${jobId})`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
