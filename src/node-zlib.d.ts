declare module "node:zlib" {
  export const constants: Record<string, number>;
  export function brotliCompressSync(
    input: ArrayBufferView | string,
    options?: { params?: Record<number, number> },
  ): Uint8Array;
  export function brotliDecompressSync(input: ArrayBufferView): Uint8Array;
}
