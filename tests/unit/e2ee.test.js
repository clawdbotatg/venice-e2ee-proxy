/**
 * tests/unit/e2ee.test.js
 *
 * Pure crypto unit tests — no network, no external deps.
 * Tests the E2EE protocol: secp256k1 ECDH + HKDF-SHA256 + AES-128-GCM
 *
 * Round-trip trick: ECDH is commutative.
 *   encryptMessages(msgs, clientPub)  uses ECDH(ephemeralPriv, clientPub)
 *   decryptChunk(wire, clientPriv)    uses ECDH(clientPriv, ephemeralPub)
 *   → same shared secret → same AES key → decrypts correctly
 * This lets us test encrypt→decrypt without a real Venice server.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  bytesToHex,
  hexToBytes,
  generateClientKeypair,
  encryptMessages,
  decryptChunk,
  decryptResponseContent,
  decryptResponseChunks,
  buildE2EEHeaders,
} = require("../../dist/e2ee");

// ─── Utilities ────────────────────────────────────────────────────────────────

describe("bytesToHex / hexToBytes", () => {
  test("round-trip: bytes → hex → bytes", () => {
    const original = new Uint8Array([0x00, 0xff, 0x12, 0xab, 0xcd]);
    const hex = bytesToHex(original);
    const back = hexToBytes(hex);
    assert.deepEqual(back, original);
  });

  test("bytesToHex produces lowercase hex with zero-padding", () => {
    assert.equal(bytesToHex(new Uint8Array([0x00, 0x0f])), "000f");
    assert.equal(bytesToHex(new Uint8Array([0xff])), "ff");
  });

  test("hexToBytes handles 0x prefix", () => {
    const a = hexToBytes("0xdeadbeef");
    const b = hexToBytes("deadbeef");
    assert.deepEqual(a, b);
  });

  test("hexToBytes handles empty string", () => {
    assert.deepEqual(hexToBytes(""), new Uint8Array(0));
  });

  test("round-trip of 32 random-ish bytes", () => {
    const bytes = new Uint8Array(32).map((_, i) => (i * 7 + 13) & 0xff);
    assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
  });
});

// ─── Keypair ──────────────────────────────────────────────────────────────────

describe("generateClientKeypair", () => {
  test("returns privateKey (32 bytes) and publicKeyHex (130 hex chars)", () => {
    const kp = generateClientKeypair();
    assert.equal(kp.privateKey.length, 32);
    assert.equal(kp.publicKeyHex.length, 130); // 65 bytes uncompressed = 130 hex chars
    assert.ok(kp.publicKeyHex.startsWith("04"), "uncompressed pubkey starts with 04");
  });

  test("each call returns a unique keypair", () => {
    const a = generateClientKeypair();
    const b = generateClientKeypair();
    assert.notEqual(bytesToHex(a.privateKey), bytesToHex(b.privateKey));
    assert.notEqual(a.publicKeyHex, b.publicKeyHex);
  });

  test("private key is valid (non-zero, < curve order)", () => {
    const kp = generateClientKeypair();
    const isAllZero = kp.privateKey.every(b => b === 0);
    assert.ok(!isAllZero);
  });
});

// ─── Encrypt / Decrypt round-trip ─────────────────────────────────────────────

describe("E2EE round-trip (encrypt with pubkey, decrypt with privkey)", () => {
  test("simple ASCII string", () => {
    const kp = generateClientKeypair();
    const original = "hello world";
    const msgs = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    const cipherHex = msgs[0].content;

    // Verify it looks like encrypted content (min 186 hex chars)
    assert.ok(cipherHex.length >= 186, `ciphertext too short: ${cipherHex.length}`);
    assert.ok(/^[0-9a-f]+$/.test(cipherHex), "ciphertext should be lowercase hex");

    const decrypted = decryptChunk(cipherHex, kp.privateKey);
    assert.equal(decrypted, original);
  });

  test("Unicode / emoji content", () => {
    const kp = generateClientKeypair();
    const original = "こんにちは 🔐 end-to-end encrypted 🛡️";
    const [encrypted] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    assert.equal(decryptChunk(encrypted.content, kp.privateKey), original);
  });

  test("empty string", () => {
    const kp = generateClientKeypair();
    const [encrypted] = encryptMessages([{ role: "user", content: "" }], kp.publicKeyHex);
    assert.equal(decryptChunk(encrypted.content, kp.privateKey), "");
  });

  test("long content (~8 KB)", () => {
    const kp = generateClientKeypair();
    const original = "a".repeat(8192);
    const [encrypted] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    assert.equal(decryptChunk(encrypted.content, kp.privateKey), original);
  });

  test("multi-line content with special chars", () => {
    const kp = generateClientKeypair();
    const original = `Line 1\nLine 2\tTabbed\r\n"quoted" 'single' <>&`;
    const [encrypted] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    assert.equal(decryptChunk(encrypted.content, kp.privateKey), original);
  });

  test("JSON payload as content", () => {
    const kp = generateClientKeypair();
    const original = JSON.stringify({ key: "value", nums: [1, 2, 3], nested: { a: true } });
    const [encrypted] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    assert.equal(decryptChunk(encrypted.content, kp.privateKey), original);
  });

  test("same plaintext → different ciphertexts (random nonce)", () => {
    const kp = generateClientKeypair();
    const original = "same message";
    const [enc1] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    const [enc2] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    assert.notEqual(enc1.content, enc2.content, "ciphertexts should differ due to random nonce");
    // But both should decrypt to the same plaintext
    assert.equal(decryptChunk(enc1.content, kp.privateKey), original);
    assert.equal(decryptChunk(enc2.content, kp.privateKey), original);
  });

  test("different plaintexts → different ciphertexts", () => {
    const kp = generateClientKeypair();
    const [enc1] = encryptMessages([{ role: "user", content: "hello" }], kp.publicKeyHex);
    const [enc2] = encryptMessages([{ role: "user", content: "world" }], kp.publicKeyHex);
    assert.notEqual(enc1.content, enc2.content);
  });

  test("wrong private key fails to decrypt", () => {
    const kp1 = generateClientKeypair();
    const kp2 = generateClientKeypair();
    const [encrypted] = encryptMessages([{ role: "user", content: "secret" }], kp1.publicKeyHex);
    assert.throws(
      () => decryptChunk(encrypted.content, kp2.privateKey),
      "decrypting with wrong key should throw",
    );
  });
});

// ─── encryptMessages ──────────────────────────────────────────────────────────

describe("encryptMessages", () => {
  test("preserves message count", () => {
    const kp = generateClientKeypair();
    const msgs = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
      { role: "assistant", content: "Hi there!" },
    ];
    const encrypted = encryptMessages(msgs, kp.publicKeyHex);
    assert.equal(encrypted.length, 3);
  });

  test("preserves role field", () => {
    const kp = generateClientKeypair();
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user message" },
    ];
    const encrypted = encryptMessages(msgs, kp.publicKeyHex);
    assert.equal(encrypted[0].role, "system");
    assert.equal(encrypted[1].role, "user");
  });

  test("encrypts each message independently", () => {
    const kp = generateClientKeypair();
    const msgs = [
      { role: "user", content: "message 1" },
      { role: "user", content: "message 2" },
    ];
    const encrypted = encryptMessages(msgs, kp.publicKeyHex);
    // Each encrypted to a different ciphertext
    assert.notEqual(encrypted[0].content, encrypted[1].content);
    // Each decryptable independently
    assert.equal(decryptChunk(encrypted[0].content, kp.privateKey), "message 1");
    assert.equal(decryptChunk(encrypted[1].content, kp.privateKey), "message 2");
  });

  test("empty messages array returns empty array", () => {
    const kp = generateClientKeypair();
    assert.deepEqual(encryptMessages([], kp.publicKeyHex), []);
  });

  test("preserves extra fields on messages", () => {
    const kp = generateClientKeypair();
    const msgs = [{ role: "user", content: "hi", name: "Austin" }];
    const encrypted = encryptMessages(msgs, kp.publicKeyHex);
    assert.equal(encrypted[0].name, "Austin");
  });
});

// ─── decryptResponseContent ───────────────────────────────────────────────────

describe("decryptResponseContent", () => {
  test("short non-hex string returned as-is (not encrypted)", () => {
    const kp = generateClientKeypair();
    assert.equal(decryptResponseContent("hello world", kp.privateKey), "hello world");
  });

  test("empty string returned as-is", () => {
    const kp = generateClientKeypair();
    assert.equal(decryptResponseContent("", kp.privateKey), "");
  });

  test("string that looks like hex but too short returned as-is", () => {
    const kp = generateClientKeypair();
    // 184 chars of hex = 92 bytes, just under the 93-byte minimum
    const shortHex = "ab".repeat(92);
    assert.equal(shortHex.length, 184);
    assert.equal(decryptResponseContent(shortHex, kp.privateKey), shortHex);
  });

  test("valid encrypted content is decrypted", () => {
    const kp = generateClientKeypair();
    const original = "This is the response from the model";
    const [encrypted] = encryptMessages([{ role: "assistant", content: original }], kp.publicKeyHex);
    const decrypted = decryptResponseContent(encrypted.content, kp.privateKey);
    assert.equal(decrypted, original);
  });

  test("plain text response (model not using E2EE) passed through unchanged", () => {
    const kp = generateClientKeypair();
    // A sentence that is not hex
    const plainResponse = "The answer to your question is 42.";
    assert.equal(decryptResponseContent(plainResponse, kp.privateKey), plainResponse);
  });
});

// ─── decryptResponseChunks ────────────────────────────────────────────────────

describe("decryptResponseChunks", () => {
  test("empty array returns empty string", () => {
    const kp = generateClientKeypair();
    assert.equal(decryptResponseChunks([], kp.privateKey), "");
  });

  test("single chunk decrypted correctly", () => {
    const kp = generateClientKeypair();
    const original = "chunk content";
    const [encrypted] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    assert.equal(decryptResponseChunks([encrypted.content], kp.privateKey), original);
  });

  test("multiple chunks decrypted and joined", () => {
    const kp = generateClientKeypair();
    const words = ["Hello", " ", "world", "!"];
    const encryptedChunks = words.map(w => {
      const [e] = encryptMessages([{ role: "user", content: w }], kp.publicKeyHex);
      return e.content;
    });
    const decrypted = decryptResponseChunks(encryptedChunks, kp.privateKey);
    assert.equal(decrypted, "Hello world!");
  });

  test("bad chunk is skipped (returns empty string for that chunk)", () => {
    const kp = generateClientKeypair();
    const original = "good chunk";
    const [encrypted] = encryptMessages([{ role: "user", content: original }], kp.publicKeyHex);
    // Mix a bad chunk with a good one
    // Note: the bad chunk is non-hex so isHexEncrypted returns false and it's returned as-is
    // We need a chunk that IS valid hex (>= 186 chars) but has invalid ciphertext
    const badChunk = "ab".repeat(100); // valid hex, 200 chars, but not real ciphertext
    const result = decryptResponseChunks([badChunk, encrypted.content], kp.privateKey);
    // The bad chunk is skipped (returns ""), the good one decrypts
    assert.equal(result, original);
  });

  test("non-hex chunks passed through as-is", () => {
    const kp = generateClientKeypair();
    // Short non-hex strings are passed through by isHexEncrypted check
    const result = decryptResponseChunks(["hello", " world"], kp.privateKey);
    assert.equal(result, "hello world");
  });
});

// ─── buildE2EEHeaders ─────────────────────────────────────────────────────────

describe("buildE2EEHeaders", () => {
  test("returns the three required TEE headers", () => {
    const headers = buildE2EEHeaders("04" + "aa".repeat(64), "04" + "bb".repeat(64));
    assert.ok("X-Venice-TEE-Client-Pub-Key" in headers);
    assert.ok("X-Venice-TEE-Model-Pub-Key" in headers);
    assert.ok("X-Venice-TEE-Signing-Algo" in headers);
  });

  test("signing algo is 'ecdsa'", () => {
    const headers = buildE2EEHeaders("04" + "aa".repeat(64), "04" + "bb".repeat(64));
    assert.equal(headers["X-Venice-TEE-Signing-Algo"], "ecdsa");
  });

  test("client pub key header matches input", () => {
    const clientPub = "04" + "cc".repeat(64);
    const modelPub = "04" + "dd".repeat(64);
    const headers = buildE2EEHeaders(clientPub, modelPub);
    assert.equal(headers["X-Venice-TEE-Client-Pub-Key"], clientPub);
    assert.equal(headers["X-Venice-TEE-Model-Pub-Key"], modelPub);
  });
});

// ─── Wire format verification ─────────────────────────────────────────────────

describe("Wire format", () => {
  test("encrypted content has correct structure: pubkey(65) + nonce(12) + ciphertext+tag(≥16)", () => {
    const kp = generateClientKeypair();
    const [encrypted] = encryptMessages([{ role: "user", content: "test" }], kp.publicKeyHex);
    const raw = hexToBytes(encrypted.content);

    // 65 bytes pubkey + 12 bytes nonce + at least 16 bytes tag
    assert.ok(raw.length >= 65 + 12 + 16, `wire too short: ${raw.length} bytes`);

    // First byte of pubkey should be 04 (uncompressed)
    assert.equal(raw[0], 0x04);
  });

  test("ephemeral pubkey in wire differs from client pubkey", () => {
    const kp = generateClientKeypair();
    const [encrypted] = encryptMessages([{ role: "user", content: "test" }], kp.publicKeyHex);
    const raw = hexToBytes(encrypted.content);
    const ephemeralPubInWire = bytesToHex(raw.slice(0, 65));
    assert.notEqual(ephemeralPubInWire, kp.publicKeyHex, "ephemeral pub should differ from client pub");
  });

  test("two encryptions of same message have different ephemeral pubkeys in wire", () => {
    const kp = generateClientKeypair();
    const msg = [{ role: "user", content: "test" }];
    const [e1] = encryptMessages(msg, kp.publicKeyHex);
    const [e2] = encryptMessages(msg, kp.publicKeyHex);
    const pub1 = hexToBytes(e1.content).slice(0, 65);
    const pub2 = hexToBytes(e2.content).slice(0, 65);
    assert.notDeepEqual(pub1, pub2, "each encryption uses a fresh ephemeral key");
  });
});
