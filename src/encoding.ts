import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { TaskInput } from "./checks.js";

/** BN254 (bn128) scalar field prime. All circuit values are reduced mod p. */
export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * How the string `task_id` becomes a circuit field element. The platform
 * does not publish this mapping (see ../PROTOCOL.md §5.4); it is switchable
 * via TASK_ID_ENCODING so practice mode can settle it without code changes.
 */
export const TASK_ID_ENCODINGS = ["keccak", "sha256", "ascii", "hex-digits"] as const;
export type TaskIdEncoding = (typeof TASK_ID_ENCODINGS)[number];

const mod = (x: bigint): bigint => ((x % BN254_P) + BN254_P) % BN254_P;

export function taskIdToField(taskId: string, encoding: TaskIdEncoding): bigint {
  switch (encoding) {
    case "keccak":
      return mod(BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(taskId)))}`));
    case "sha256":
      return mod(BigInt(`0x${bytesToHex(sha256(utf8ToBytes(taskId)))}`));
    case "ascii": {
      const bytes = utf8ToBytes(taskId);
      return bytes.length === 0 ? 0n : mod(BigInt(`0x${bytesToHex(bytes)}`));
    }
    case "hex-digits": {
      // e.g. "gk_24_9d1": hex-looking chunks after the prefix, concatenated.
      const digits = taskId.replace(/^gk_/, "").replace(/[^0-9a-fA-F]/g, "");
      return digits === "" ? 0n : mod(BigInt(`0x${digits}`));
    }
  }
}

/** Circuit input object for the gatekeeper circuit (decimal strings). */
export function toCircuitInputs(
  input: TaskInput,
  taskId: string,
  decision: "APPROVE" | "REJECT",
  salt: bigint,
  encoding: TaskIdEncoding,
): Record<string, string> {
  const f = (x: bigint): string => mod(x).toString();
  return {
    taskId: f(taskIdToField(taskId, encoding)),
    minimum: f(input.minimum),
    publicBalance: f(input.publicBalance),
    expiryBlock: f(input.expiryBlock),
    currentBlock: f(input.currentBlock),
    recipient: f(input.recipient),
    conditionRecipient: f(input.conditionRecipient),
    amount: f(input.amount),
    maxTransfer: f(input.maxTransfer),
    registeredVkHash: f(input.registeredVk),
    proofVkHash: f(input.proofVk),
    salt: f(salt),
    decision: decision === "APPROVE" ? "1" : "0",
  };
}
