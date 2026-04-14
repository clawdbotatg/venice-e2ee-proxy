/**
 * e2ee.ts — Venice E2EE crypto implementation for Node.js
 *
 * Ported from zkllmapi-v2/packages/nextjs/utils/e2ee.ts
 *
 * Protocol:
 *   Encrypt: ephemeral ECDH → HKDF("ecdsa_encryption") → AES-128-GCM
 *   Wire format (hex): ephemeralPub[65] || nonce[12] || ciphertext+tag
 *   Decrypt: client ECDH with server ephemeral → same KDF → AES-GCM
 */
import { gcm } from "@noble/ciphers/aes";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes as nodeRandomBytes } from "crypto";

const HKDF_INFO = new TextEncoder().encode("ecdsa_encryption");

// ─── Utilities ───────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function randomBytes(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n));
}

function normalizeToUncompressedPubkey(keyHex: string): string {
  if (keyHex.startsWith("04") && keyHex.length === 130) return keyHex;
  if (!keyHex.startsWith("04") && keyHex.length === 128) return "04" + keyHex;
  const point = secp256k1.ProjectivePoint.fromHex(keyHex);
  return bytesToHex(point.toRawBytes(false));
}

function ecdhSharedSecret(privateKey: Uint8Array, publicKeyHex: string): Uint8Array {
  const normalized = normalizeToUncompressedPubkey(publicKeyHex);
  const sharedPoint = secp256k1.getSharedSecret(privateKey, normalized, false);
  // x-coordinate only (bytes 1-33 of uncompressed point)
  return sharedPoint.slice(1, 33);
}

// ─── Keypair ─────────────────────────────────────────────────────

export interface ClientKeypair {
  privateKey: Uint8Array;
  publicKeyHex: string;
}

export function generateClientKeypair(): ClientKeypair {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, false); // 65 bytes uncompressed
  return {
    privateKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}

// ─── Encryption ──────────────────────────────────────────────────

function encryptMessage(plaintext: string, modelPublicKeyHex: string): string {
  const ephemeralPriv = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, false); // 65 bytes

  const shared = ecdhSharedSecret(ephemeralPriv, modelPublicKeyHex);
  const aesKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  const nonce = randomBytes(12);
  const cipher = gcm(aesKey, nonce);
  const encrypted = cipher.encrypt(new TextEncoder().encode(plaintext));

  const result = new Uint8Array(65 + 12 + encrypted.length);
  result.set(ephemeralPub, 0);
  result.set(nonce, 65);
  result.set(encrypted, 65 + 12);

  return bytesToHex(result);
}

export function encryptMessages(
  messages: { role: string; content: string }[],
  modelPublicKeyHex: string,
): { role: string; content: string }[] {
  return messages.map(msg => ({
    ...msg,
    content: encryptMessage(msg.content, modelPublicKeyHex),
  }));
}

// ─── Decryption ──────────────────────────────────────────────────

function isHexEncrypted(s: string): boolean {
  // Minimum: 65 (pub) + 12 (nonce) + 16 (tag) = 93 bytes = 186 hex chars
  return s.length >= 186 && /^[0-9a-fA-F]+$/.test(s);
}

export function decryptChunk(ciphertextHex: string, clientPrivateKey: Uint8Array): string {
  const raw = hexToBytes(ciphertextHex);

  const serverEphemeralPubHex = bytesToHex(raw.slice(0, 65));
  const nonce = raw.slice(65, 65 + 12);
  const ciphertext = raw.slice(65 + 12);

  const shared = ecdhSharedSecret(clientPrivateKey, serverEphemeralPubHex);
  const aesKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  const cipher = gcm(aesKey, nonce);
  return new TextDecoder().decode(cipher.decrypt(ciphertext));
}

export function decryptResponseContent(content: string, clientPrivateKey: Uint8Array): string {
  if (!isHexEncrypted(content)) return content;
  return decryptChunk(content, clientPrivateKey);
}

export function decryptResponseChunks(chunks: string[], clientPrivateKey: Uint8Array): string {
  return chunks
    .map(chunk => {
      try {
        return isHexEncrypted(chunk) ? decryptChunk(chunk, clientPrivateKey) : chunk;
      } catch {
        return "";
      }
    })
    .join("");
}

// ─── TEE Headers ─────────────────────────────────────────────────

export function buildE2EEHeaders(
  clientPublicKeyHex: string,
  modelPublicKeyHex: string,
): Record<string, string> {
  return {
    "X-Venice-TEE-Client-Pub-Key": clientPublicKeyHex,
    "X-Venice-TEE-Model-Pub-Key": modelPublicKeyHex,
    "X-Venice-TEE-Signing-Algo": "ecdsa",
  };
}

export { normalizeToUncompressedPubkey };
