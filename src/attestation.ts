/**
 * attestation.ts — Fetch and cache Venice TEE attestation
 */
import { randomBytes } from "crypto";
import { bytesToHex, normalizeToUncompressedPubkey } from "./e2ee";

interface AttestationCache {
  modelPublicKeyHex: string;
  teeProvider: string;
  debugMode: boolean;
  fetchedAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
let cache: Map<string, AttestationCache> = new Map();

export interface AttestationResult {
  modelPublicKeyHex: string;
  teeProvider: string;
  debugMode: boolean;
  age: number;
}

export async function getModelPublicKey(
  model: string,
  apiKey: string,
  verbose: boolean = false,
): Promise<AttestationResult> {
  const cached = cache.get(model);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    if (verbose) {
      console.log(`[attestation] using cached key for ${model} (age: ${Math.round((Date.now() - cached.fetchedAt) / 1000)}s)`);
    }
    return {
      modelPublicKeyHex: cached.modelPublicKeyHex,
      teeProvider: cached.teeProvider,
      debugMode: cached.debugMode,
      age: Date.now() - cached.fetchedAt,
    };
  }

  const nonce = bytesToHex(new Uint8Array(randomBytes(32)));
  const url = `https://api.venice.ai/api/v1/tee/attestation?model=${encodeURIComponent(model)}&nonce=${nonce}`;

  if (verbose) {
    console.log(`[attestation] fetching attestation for ${model}...`);
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Attestation fetch failed (${res.status}): ${body}`);
  }

  const att: any = await res.json();

  if (att.nonce !== nonce) {
    throw new Error("Attestation nonce mismatch — possible MITM");
  }

  if (!att.verified) {
    throw new Error("Attestation verification failed — TEE not verified");
  }

  const signingKey = att.signing_key || att.signing_public_key;
  if (!signingKey) {
    throw new Error("Attestation response missing signing key");
  }

  const modelPublicKeyHex = normalizeToUncompressedPubkey(signingKey);
  const teeProvider = att.server_verification?.tee_provider || att.tee_provider || "unknown";
  const debugMode = att.server_verification?.tdx_debug_mode === true;

  if (verbose) {
    console.log(`[attestation] ✓ verified for ${model}`);
    console.log(`[attestation]   signing key: ${modelPublicKeyHex.slice(0, 20)}...`);
    console.log(`[attestation]   TEE provider: ${teeProvider}`);
    console.log(`[attestation]   TDX debug mode: ${debugMode ? "Yes ⚠️" : "No"}`);
  }

  const entry: AttestationCache = {
    modelPublicKeyHex,
    teeProvider,
    debugMode,
    fetchedAt: Date.now(),
  };
  cache.set(model, entry);

  return {
    modelPublicKeyHex,
    teeProvider,
    debugMode,
    age: 0,
  };
}

export function getAttestationAge(model: string): number | null {
  const cached = cache.get(model);
  if (!cached) return null;
  return Date.now() - cached.fetchedAt;
}
