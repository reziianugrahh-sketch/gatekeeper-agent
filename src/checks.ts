/**
 * Deterministic decision logic for Proof Gatekeeper tasks.
 * Pure functions: same input -> same verdict. No model is involved.
 * Check semantics mirror the gatekeeper circuit exactly (see
 * ../PROTOCOL.md §4 and §6.2), including the strict expiry comparison.
 */

export interface TaskInput {
  registeredVk: bigint;
  proofVk: bigint;
  minimum: bigint;
  publicBalance: bigint;
  expiryBlock: bigint;
  currentBlock: bigint;
  recipient: bigint;
  conditionRecipient: bigint;
  amount: bigint;
  maxTransfer: bigint;
  /** Proof reference (`proof_tx`), exactly as received. */
  proofTx: string;
}

export type Decision = "APPROVE" | "REJECT";

export const REASON_CODES = {
  VALID: "VALID_CONDITION",
  VK_SUBSTITUTION: "VK_SUBSTITUTION",
  THRESHOLD_MISMATCH: "THRESHOLD_MISMATCH",
  RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
  AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
  EXPIRED_CONDITION: "EXPIRED_CONDITION",
  PROOF_REUSED: "PROOF_REUSED",
  /** Signed envelope whose input could not be parsed. No official code exists. */
  MALFORMED: "PUBLIC_INPUT_MISMATCH",
} as const;

export interface Verdict {
  decision: Decision;
  reasonCode: string;
}

const reject = (reasonCode: string): Verdict => ({ decision: "REJECT", reasonCode });

/**
 * The checks, in the order specified for this build. `alreadySeen` says the
 * task's proof_tx was already answered under a different task_id.
 *
 * NOTE on expiry: approval requires currentBlock < expiryBlock (strict).
 * The circuit refuses to prove an approval at currentBlock == expiryBlock
 * (verified empirically, PROTOCOL.md §6.2).
 */
export function decide(input: TaskInput, alreadySeen: boolean): Verdict {
  if (input.proofVk !== input.registeredVk) return reject(REASON_CODES.VK_SUBSTITUTION);
  if (input.publicBalance < input.minimum) return reject(REASON_CODES.THRESHOLD_MISMATCH);
  if (input.recipient !== input.conditionRecipient) return reject(REASON_CODES.RECIPIENT_MISMATCH);
  if (input.amount > input.maxTransfer) return reject(REASON_CODES.AMOUNT_OVERFLOW);
  if (input.currentBlock >= input.expiryBlock) return reject(REASON_CODES.EXPIRED_CONDITION);
  if (alreadySeen) return reject(REASON_CODES.PROOF_REUSED);
  return { decision: "APPROVE", reasonCode: REASON_CODES.VALID };
}

export class MalformedInput extends Error {}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new MalformedInput(`${field}: not an integer`);
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(s)) return BigInt(s);
    throw new MalformedInput(`${field}: not a numeric string`);
  }
  throw new MalformedInput(`${field}: missing or wrong type`);
}

/** Parse and validate the envelope's `input` object. Throws MalformedInput. */
export function parseTaskInput(raw: unknown): TaskInput {
  if (raw === null || typeof raw !== "object") {
    throw new MalformedInput("input: missing or not an object");
  }
  const o = raw as Record<string, unknown>;
  const proofTx = o.proof_tx;
  if (typeof proofTx !== "string" || proofTx.length === 0) {
    throw new MalformedInput("proof_tx: missing or not a string");
  }
  return {
    registeredVk: toBigInt(o.registered_vk, "registered_vk"),
    proofVk: toBigInt(o.proof_vk, "proof_vk"),
    minimum: toBigInt(o.minimum, "minimum"),
    publicBalance: toBigInt(o.public_balance, "public_balance"),
    expiryBlock: toBigInt(o.expiry_block, "expiry_block"),
    currentBlock: toBigInt(o.current_block, "current_block"),
    recipient: toBigInt(o.recipient, "recipient"),
    conditionRecipient: toBigInt(o.condition_recipient, "condition_recipient"),
    amount: toBigInt(o.amount, "amount"),
    maxTransfer: toBigInt(o.max_transfer, "max_transfer"),
    proofTx,
  };
}

/** Normalised seen-set key for a proof reference. */
export function proofRefKey(proofTx: string): string {
  return proofTx.toLowerCase();
}
