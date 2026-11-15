import {
  MalformedInput,
  REASON_CODES,
  decide,
  parseTaskInput,
  type TaskInput,
} from "./checks.js";
import { toCircuitInputs, type TaskIdEncoding } from "./encoding.js";
import type { Prover } from "./prover.js";
import type { TaskStore } from "./store.js";

export interface AnsweredTask {
  taskId: string;
  decision: string;
  reasonCode: string;
  proof: unknown | null;
  publicSignals: string[] | null;
}

export interface GatekeeperDeps {
  store: TaskStore;
  prover: Prover;
  taskIdEncoding: TaskIdEncoding;
  /** Upper bound on proving time per task. */
  proofBudgetMs: number;
  /** Margin kept before `deadline_at` for signing and sending. */
  deadlineMarginMs: number;
  /** Called once per newly answered task (never for retries). Off the scoring path. */
  onAnswered?: (answered: AnsweredTask) => void;
  now?: () => number;
}

/**
 * Turns one verified task envelope into the exact response body string that
 * the server signs and sends. Decision first (deterministic), proof second
 * (best effort), response persisted for idempotent retries.
 */
export class Gatekeeper {
  /** Tasks being answered right now, so a concurrent retry waits for the same answer. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: GatekeeperDeps) {}

  async handle(envelope: Record<string, unknown>): Promise<string> {
    const taskId = typeof envelope.task_id === "string" ? envelope.task_id : null;
    if (taskId === null) {
      console.error("[gatekeeper] malformed envelope: task_id missing");
      return JSON.stringify({ decision: "REJECT", reason_code: REASON_CODES.MALFORMED });
    }
    const pending = this.inFlight.get(taskId);
    if (pending) return pending;
    const work = this.answer(taskId, envelope).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, work);
    return work;
  }

  private async answer(taskId: string, envelope: Record<string, unknown>): Promise<string> {
    const mode = typeof envelope.mode === "string" ? envelope.mode : "competition";
    const rawInput = (envelope.input ?? null) as Record<string, unknown> | null;
    const proofTxEcho = typeof rawInput?.proof_tx === "string" ? rawInput.proof_tx : undefined;

    let input: TaskInput | null = null;
    let parseError: string | null = null;
    try {
      input = parseTaskInput(rawInput);
    } catch (e) {
      if (!(e instanceof MalformedInput)) throw e;
      parseError = e.message;
    }

    const claim = await this.deps.store.claim({
      taskId,
      mode,
      proofTx: input ? input.proofTx : null,
      decideFn: (alreadySeen) => {
        if (!input) return { decision: "REJECT" as const, reasonCode: REASON_CODES.MALFORMED };
        return decide(input, alreadySeen);
      },
    });

    if (claim.kind === "existing" && claim.record.responseBody !== null) {
      console.log(`[gatekeeper] retry task=${taskId} -> stored response`);
      return claim.record.responseBody;
    }
    // New task, or one recorded before a crash but never answered: (re)make the proof
    // with the persisted salt and decision so the answer is stable.
    const record = claim.record;

    // PROOF_REUSED has no provable statement (the circuit cannot see the
    // seen-set) and malformed inputs have nothing to prove; both answer
    // without a proof, per the event page. Everything else is provable.
    const provable =
      input !== null &&
      record.reasonCode !== REASON_CODES.PROOF_REUSED &&
      record.reasonCode !== REASON_CODES.MALFORMED;

    const body: Record<string, unknown> = {
      decision: record.decision,
      reason_code: record.reasonCode,
    };
    let proof: unknown | null = null;
    let publicSignals: string[] | null = null;

    if (provable && input) {
      const outcome = await this.deps.prover.prove(
        toCircuitInputs(
          input,
          taskId,
          record.decision as "APPROVE" | "REJECT",
          BigInt(record.salt),
          this.deps.taskIdEncoding,
        ),
        this.budget(envelope.deadline_at),
      );
      if (outcome.ok) {
        proof = outcome.proof;
        publicSignals = outcome.publicSignals;
        body.proof = outcome.proof;
        body.public_signals = outcome.publicSignals;
        console.log(
          `[gatekeeper] task=${taskId} ${record.decision}/${record.reasonCode} proof ok in ${outcome.ms} ms (local verify=${outcome.locallyVerified})`,
        );
      } else {
        console.error(
          `[gatekeeper] task=${taskId} proof FAILED (${outcome.error}) — answering without proof`,
        );
      }
    } else {
      console.log(
        `[gatekeeper] task=${taskId} ${record.decision}/${record.reasonCode} (no proof: ${parseError ?? record.reasonCode})`,
      );
    }
    if (proofTxEcho !== undefined) body.proof_tx = proofTxEcho;

    const responseBody = JSON.stringify(body);
    await this.deps.store.complete(taskId, responseBody);
    try {
      this.deps.onAnswered?.({
        taskId,
        decision: record.decision,
        reasonCode: record.reasonCode,
        proof,
        publicSignals,
      });
    } catch (e) {
      console.error(`[gatekeeper] onAnswered hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return responseBody;
  }

  /** Proving budget: the configured cap, shortened to land before the deadline. */
  private budget(deadlineAt: unknown): number {
    const deadline = typeof deadlineAt === "string" ? Date.parse(deadlineAt) : NaN;
    if (Number.isNaN(deadline)) return this.deps.proofBudgetMs;
    const now = this.deps.now ? this.deps.now() : Date.now();
    return Math.min(this.deps.proofBudgetMs, deadline - now - this.deps.deadlineMarginMs);
  }
}
