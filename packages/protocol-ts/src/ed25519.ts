import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export interface KeyPair {
  seedHex: string;
  pubHex: string;
}

export function keyPairFromSeed(seedHex: string): KeyPair {
  const seed = hexToBytes(seedHex);
  if (seed.length !== 32) {
    throw new Error(`ed25519: seed must be 32 bytes, got ${seed.length}`);
  }
  return { seedHex, pubHex: bytesToHex(ed25519.getPublicKey(seed)) };
}

export function sign(seedHex: string, message: Uint8Array): string {
  const seed = hexToBytes(seedHex);
  if (seed.length !== 32) {
    throw new Error(`ed25519: seed must be 32 bytes, got ${seed.length}`);
  }
  return bytesToHex(ed25519.sign(message, seed));
}

export function verify(pubHex: string, message: Uint8Array, sigHex: string): boolean {
  try {
    const pub = hexToBytes(pubHex);
    const sig = hexToBytes(sigHex);
    if (pub.length !== 32 || sig.length !== 64) return false;
    return ed25519.verify(sig, message, pub);
  } catch {
    return false;
  }
}