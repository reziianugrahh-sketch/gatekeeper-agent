import { readFileSync } from "node:fs";
import { join } from "node:path";
// snarkjs ships no types; see snarkjs.d.ts.
import * as snarkjs from "snarkjs";

export type ProveOutcome =
  | {
      ok: true;
      proof: unknown;
      publicSignals: string[];
      locallyVerified: boolean;
      ms: number;
    }
  | { ok: false; error: string; ms: number };

/** Local Groth16 proving against the official gatekeeper artifacts. */
export class Prover {
  private readonly wasm: string;
  private readonly zkey: string;
  private readonly vk: unknown;

  constructor(circuitDir: string) {
    this.wasm = join(circuitDir, "gatekeeper.wasm");
    this.zkey = join(circuitDir, "gatekeeper_final.zkey");
    this.vk = JSON.parse(readFileSync(join(circuitDir, "gatekeeper_vk.json"), "utf8"));
  }

  /**
   * Best effort: never throws. A failed proof never changes the decision —
   * the caller answers without a proof (scored as a missing proof) rather
   * than flipping a correct decision or missing the deadline.
   */
  async prove(inputs: Record<string, string>, budgetMs: number): Promise<ProveOutcome> {
    const start = Date.now();
    if (budgetMs <= 0) return { ok: false, error: "no proving budget left", ms: 0 };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`proving exceeded ${budgetMs} ms`)), budgetMs);
    });
    try {
      const { proof, publicSignals } = await Promise.race([
        snarkjs.groth16.fullProve(inputs, this.wasm, this.zkey),
        timeout,
      ]);
      const locallyVerified = await snarkjs.groth16.verify(this.vk, publicSignals, proof);
      return { ok: true, proof, publicSignals, locallyVerified, ms: Date.now() - start };
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      return { ok: false, error: msg, ms: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Releases snarkjs worker threads (needed for a clean process exit). */
export async function shutdownProver(): Promise<void> {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  if (curve) await curve.terminate();
}
