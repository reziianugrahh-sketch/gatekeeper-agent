import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { proofRefKey, type Verdict } from "./checks.js";

/**
 * Persistent task store (single JSON file, atomic replace on write).
 *
 * Holds, per task_id: the salt chosen for its proof, the decision made and
 * the exact response body once answered — so platform retries are answered
 * idempotently and a crash mid-proof can resume with the same salt/decision.
 * Also holds the seen-set of proof_tx values (reuse detection) across
 * restarts. Scale is tiny (8 tasks/day), so a JSON file is plenty.
 */
export interface TaskRecord {
  taskId: string;
  mode: string;
  proofTx: string | null;
  salt: string;
  decision: string;
  reasonCode: string;
  responseBody: string | null;
}

interface StoreData {
  tasks: Record<string, TaskRecord>;
  seenProofs: Record<string, string>; // proofRefKey -> first taskId
}

export type Claim =
  | { kind: "existing"; record: TaskRecord }
  | { kind: "new"; record: TaskRecord };

export interface ClaimArgs {
  taskId: string;
  mode: string;
  proofTx: string | null;
  decideFn: (alreadySeen: boolean) => Verdict;
}

/**
 * The store contract Gatekeeper depends on. Implementations may be
 * synchronous (file store) or asynchronous (KV store); callers await
 * either. `claim` must be effectively atomic per task_id: a concurrent
 * or repeated claim for the same task returns the same record.
 */
export interface TaskStore {
  claim(args: ClaimArgs): Claim | Promise<Claim>;
  complete(taskId: string, responseBody: string): void | Promise<void>;
}

export class Store implements TaskStore {
  private data: StoreData;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "store.json");
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as StoreData;
    } else {
      this.data = { tasks: {}, seenProofs: {} };
    }
  }

  /**
   * Atomically claim a task: if it exists, return the stored record
   * (idempotent retry). Otherwise run `decideFn` with the proof-reuse flag,
   * persist a fresh record (with a fresh salt), and mark the proof_tx seen.
   */
  claim(args: ClaimArgs): Claim {
    const existing = this.data.tasks[args.taskId];
    if (existing) return { kind: "existing", record: existing };

    const key = args.proofTx ? proofRefKey(args.proofTx) : null;
    const alreadySeen = key !== null && key in this.data.seenProofs;
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
    this.data.tasks[args.taskId] = record;
    if (key !== null && !alreadySeen) this.data.seenProofs[key] = args.taskId;
    this.persist();
    return { kind: "new", record };
  }

  complete(taskId: string, responseBody: string): void {
    const record = this.data.tasks[taskId];
    if (!record) return;
    record.responseBody = responseBody;
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
