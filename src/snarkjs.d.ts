// snarkjs ships no TypeScript types; declare the small surface we use.
declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string | string[]>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(
      vk: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkeyPath: string): Promise<unknown>;
  };
}
