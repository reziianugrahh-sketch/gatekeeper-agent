import { randomBytes } from "node:crypto";
import { proofRefKey } from "./checks.js";
import type { Claim, ClaimArgs, TaskRecord, TaskStore } from "./store.js";

/**
 * KV-backed task store (Upstash Redis REST API, plain fetch — no SDK).
 *
 * Same contract as the file Store, for serverless hosting where the
 * filesystem is ephemeral: per-task records (salt / decision / final
 * response body) for idempotent retries, plus the proof_tx seen-set for
 * reuse detection, surviving across function instances and restarts.
 *
 * Keys:
 *   gk:task:<taskId>          -> JSON TaskRecord
 *   gk:seen:<proofRefKey>     -> first taskId that used the proof_tx
 *
 * Claim atomicity: the record is written with SET NX. If a concurrent
 * invocation wins the race, the loser re-reads and returns the winner's
 * record, so both answer identically.
 */
export class KvStore implements TaskStore {
  constructor(
    private readonly restUrl: string,
    private readonly restToken: string,
  ) {}

  private async cmd<T>(...command: string[]): Promise<T> {
    const res = await fetch(this.restUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.restToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
    const data = (await res.json()) as { result?: T; error?: string };
    if (data.error) throw new Error(`upstash error: ${data.error}`);
    return data.result as T;
  }

  private taskKey(taskId: string): string {
    return `gk:task:${taskId}`;
  }

  private seenKey(proofTx: string): string {
    return `gk:seen:${proofRefKey(proofTx)}`;
  }

  async claim(args: ClaimArgs): Promise<Claim> {
    const existing = await this.cmd<string | null>("GET", this.taskKey(args.taskId));
    if (existing !== null) {
      return { kind: "existing", record: JSON.parse(existing) as TaskRecord };
    }

    const seenKey = args.proofTx ? this.seenKey(args.proofTx) : null;
    const alreadySeen =
      seenKey !== null && (await this.cmd<string | null>("GET", seenKey)) !== null;
    const verdict = args.decideFn(alreadySeen);
    const record: TaskRecord = {
      taskId: args.taskId,
      mode: args.mode,
      proofTx: args.proofTx,
      // 31 random bytes always stay below the BN254 field prime.
      salt: BigInt(`0x${randomBytes(31).toString("hex")}`).toString(),
      decision: verdict.decision,
      reasonCode: verdict.reasonCode,
      responseBody: null,
    };

    const won = await this.cmd<string | null>(
      "SET",
      this.taskKey(args.taskId),
      JSON.stringify(record),
      "NX",
    );
    if (won === null) {
      // Lost a concurrent claim race: return the winner's record so the
      // retry/duplicate is answered identically.
      const winner = await this.cmd<string | null>("GET", this.taskKey(args.taskId));
      if (winner !== null) {
        return { kind: "existing", record: JSON.parse(winner) as TaskRecord };
      }
      throw new Error(`kv claim race for task ${args.taskId}: record vanished`);
    }

    if (seenKey !== null && !alreadySeen) {
      await this.cmd<string | null>("SET", seenKey, args.taskId, "NX");
    }
    return { kind: "new", record };
  }

  async complete(taskId: string, responseBody: string): Promise<void> {
    const raw = await this.cmd<string | null>("GET", this.taskKey(taskId));
    if (raw === null) return;
    const record = JSON.parse(raw) as TaskRecord;
    record.responseBody = responseBody;
    await this.cmd<string>("SET", this.taskKey(taskId), JSON.stringify(record));
  }
}
