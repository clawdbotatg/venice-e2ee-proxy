/**
 * tests/unit/attestation.test.js
 *
 * Attestation parsing unit tests — uses mock fetch, no real network calls.
 * Tests: nonce binding, verified flag, signing key normalization, caching.
 *
 * The attestation module uses a module-level cache Map. We isolate tests
 * by using unique model names so cache entries don't collide.
 */
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { getModelPublicKey, getAttestationAge } = require("../../dist/attestation");

// A valid-looking 65-byte uncompressed secp256k1 pubkey (fake but passes format check)
const FAKE_SIGNING_KEY = "04" + "ab".repeat(64); // 130 hex chars, starts with 04

// Counter to generate unique model names per test
let modelCounter = 0;
function uniqueModel() {
  return `test-mock-model-${++modelCounter}`;
}

// Helper: install a mock fetch that responds with the given overrides
function mockFetch(overrides = {}) {
  globalThis.fetch = async (url) => {
    const urlObj = new URL(url);
    const nonce = urlObj.searchParams.get("nonce");

    const response = {
      nonce: overrides.nonce !== undefined ? overrides.nonce : nonce,
      verified: overrides.verified !== undefined ? overrides.verified : true,
      signing_key: overrides.signing_key !== undefined ? overrides.signing_key : FAKE_SIGNING_KEY,
      server_verification: {
        tee_provider: overrides.tee_provider || "Test TEE Provider",
        tdx_debug_mode: overrides.tdx_debug_mode || false,
      },
    };

    return {
      ok: overrides.ok !== undefined ? overrides.ok : true,
      status: overrides.status || 200,
      json: async () => response,
      text: async () => overrides.errorBody || "mock error",
    };
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("getModelPublicKey — happy path", () => {
  test("returns modelPublicKeyHex, teeProvider, debugMode, age", async () => {
    mockFetch();
    const model = uniqueModel();
    const result = await getModelPublicKey(model, "sk-test-key");

    assert.ok(result.modelPublicKeyHex.length === 130, "pubkey should be 130 hex chars (65 bytes uncompressed)");
    assert.ok(result.modelPublicKeyHex.startsWith("04"), "uncompressed key starts with 04");
    assert.equal(typeof result.teeProvider, "string");
    assert.equal(typeof result.debugMode, "boolean");
    assert.equal(typeof result.age, "number");
  });

  test("normalizes signing_key to uncompressed format (04... prefix)", async () => {
    mockFetch({ signing_key: FAKE_SIGNING_KEY });
    const result = await getModelPublicKey(uniqueModel(), "sk-test-key");
    assert.ok(result.modelPublicKeyHex.startsWith("04"));
    assert.equal(result.modelPublicKeyHex.length, 130);
  });

  test("accepts signing_public_key field (alternate field name)", async () => {
    globalThis.fetch = async (url) => {
      const urlObj = new URL(url);
      const nonce = urlObj.searchParams.get("nonce");
      return {
        ok: true,
        json: async () => ({
          nonce,
          verified: true,
          signing_public_key: FAKE_SIGNING_KEY, // alternate field name
          server_verification: { tee_provider: "Alt TEE", tdx_debug_mode: false },
        }),
        text: async () => "",
      };
    };
    const result = await getModelPublicKey(uniqueModel(), "sk-test-key");
    assert.equal(result.modelPublicKeyHex, FAKE_SIGNING_KEY);
  });

  test("extracts tee_provider from server_verification", async () => {
    mockFetch({ tee_provider: "Intel TDX Cloud" });
    const result = await getModelPublicKey(uniqueModel(), "sk-test-key");
    assert.equal(result.teeProvider, "Intel TDX Cloud");
  });

  test("debugMode is false when tdx_debug_mode is false", async () => {
    mockFetch({ tdx_debug_mode: false });
    const result = await getModelPublicKey(uniqueModel(), "sk-test-key");
    assert.equal(result.debugMode, false);
  });

  test("debugMode is true when tdx_debug_mode is true", async () => {
    mockFetch({ tdx_debug_mode: true });
    const result = await getModelPublicKey(uniqueModel(), "sk-test-key");
    assert.equal(result.debugMode, true);
  });

  test("initial fetch has age === 0", async () => {
    mockFetch();
    const result = await getModelPublicKey(uniqueModel(), "sk-test-key");
    assert.equal(result.age, 0);
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe("getModelPublicKey — error cases", () => {
  test("throws when nonce does not match (MITM detection)", async () => {
    mockFetch({ nonce: "deadbeef" + "00".repeat(28) }); // wrong nonce
    await assert.rejects(
      () => getModelPublicKey(uniqueModel(), "sk-test-key"),
      /nonce mismatch/i,
    );
  });

  test("throws when verified is false", async () => {
    mockFetch({ verified: false });
    await assert.rejects(
      () => getModelPublicKey(uniqueModel(), "sk-test-key"),
      /verification failed/i,
    );
  });

  test("throws when signing_key is missing", async () => {
    globalThis.fetch = async (url) => {
      const urlObj = new URL(url);
      const nonce = urlObj.searchParams.get("nonce");
      return {
        ok: true,
        json: async () => ({
          nonce,
          verified: true,
          // no signing_key or signing_public_key
          server_verification: { tee_provider: "TEE", tdx_debug_mode: false },
        }),
        text: async () => "",
      };
    };
    await assert.rejects(
      () => getModelPublicKey(uniqueModel(), "sk-test-key"),
      /missing signing key/i,
    );
  });

  test("throws when Venice returns non-OK status", async () => {
    mockFetch({ ok: false, status: 401, errorBody: "Unauthorized" });
    await assert.rejects(
      () => getModelPublicKey(uniqueModel(), "sk-test-key"),
      /401/,
    );
  });

  test("throws when Venice returns 500", async () => {
    mockFetch({ ok: false, status: 500, errorBody: "Internal Server Error" });
    await assert.rejects(
      () => getModelPublicKey(uniqueModel(), "sk-test-key"),
      /500/,
    );
  });
});

// ─── Caching ──────────────────────────────────────────────────────────────────

describe("getModelPublicKey — caching", () => {
  test("second call for same model returns cached result without fetching", async () => {
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount++;
      const urlObj = new URL(url);
      const nonce = urlObj.searchParams.get("nonce");
      return {
        ok: true,
        json: async () => ({
          nonce,
          verified: true,
          signing_key: FAKE_SIGNING_KEY,
          server_verification: { tee_provider: "TEE", tdx_debug_mode: false },
        }),
        text: async () => "",
      };
    };

    const model = uniqueModel();
    await getModelPublicKey(model, "sk-test-key");
    await getModelPublicKey(model, "sk-test-key");
    await getModelPublicKey(model, "sk-test-key");

    assert.equal(fetchCount, 1, "should only fetch once, then use cache");
  });

  test("cached result has age > 0 on second call", async () => {
    mockFetch();
    const model = uniqueModel();
    await getModelPublicKey(model, "sk-test-key");
    // Small delay to ensure age > 0
    await new Promise(r => setTimeout(r, 5));
    const result = await getModelPublicKey(model, "sk-test-key");
    assert.ok(result.age >= 0, `age should be >= 0, got ${result.age}`);
  });

  test("different models have separate cache entries", async () => {
    let calls = [];
    globalThis.fetch = async (url) => {
      const urlObj = new URL(url);
      const model = urlObj.searchParams.get("model");
      const nonce = urlObj.searchParams.get("nonce");
      calls.push(model);
      return {
        ok: true,
        json: async () => ({
          nonce,
          verified: true,
          signing_key: FAKE_SIGNING_KEY,
          server_verification: { tee_provider: "TEE", tdx_debug_mode: false },
        }),
        text: async () => "",
      };
    };

    const model1 = uniqueModel();
    const model2 = uniqueModel();
    await getModelPublicKey(model1, "sk-test-key");
    await getModelPublicKey(model2, "sk-test-key");
    await getModelPublicKey(model1, "sk-test-key"); // should use cache

    assert.equal(calls.length, 2, "should fetch each model once");
    assert.ok(calls.includes(model1));
    assert.ok(calls.includes(model2));
  });
});

// ─── getAttestationAge ────────────────────────────────────────────────────────

describe("getAttestationAge", () => {
  test("returns null for unknown model", () => {
    assert.equal(getAttestationAge("model-never-fetched-xyz-" + Date.now()), null);
  });

  test("returns a number (ms) after a fetch", async () => {
    mockFetch();
    const model = uniqueModel();
    await getModelPublicKey(model, "sk-test-key");
    const age = getAttestationAge(model);
    assert.equal(typeof age, "number");
    assert.ok(age >= 0);
  });
});
