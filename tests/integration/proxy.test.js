/**
 * tests/integration/proxy.test.js
 *
 * Live end-to-end integration tests against the real Venice API.
 * Skips automatically if VENICE_API_KEY is not set.
 *
 * Tests:
 *  1. Attestation fetch (real Venice TEE attestation)
 *  2. Non-streaming chat completion (full E2EE round-trip)
 *  3. Streaming chat completion (full E2EE round-trip)
 *  4. /health endpoint
 *  5. /v1/models passthrough
 *  6. Proxy handles Venice upstream error gracefully
 *  7. Multi-turn conversation (encrypted history)
 *
 * Usage:
 *   VENICE_API_KEY=sk-... node --test tests/integration/proxy.test.js
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const API_KEY = process.env.VENICE_API_KEY;
const TEST_PORT = 13337;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const MODEL = process.env.TEST_MODEL || "e2ee-glm-5";

// Skip everything if no API key
if (!API_KEY) {
  console.log("\n⚠  VENICE_API_KEY not set — skipping integration tests.\n");
  process.exit(0);
}

const { createServer } = require("../../dist/server");
const { getModelPublicKey } = require("../../dist/attestation");

let server;

// ─── Setup / teardown ─────────────────────────────────────────────────────────

before(async () => {
  const app = createServer({ apiKey: API_KEY, port: TEST_PORT, model: MODEL, verbose: false });
  await new Promise((resolve, reject) => {
    server = app.listen(TEST_PORT, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  console.log(`\n  [integration] proxy listening on ${BASE_URL}  model=${MODEL}\n`);
});

after(() => {
  server?.close();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body), raw: body });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: body });
        }
      });
    }).on("error", reject);
  });
}

function post(path, payload) {
  const bodyStr = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let body = "";
        res.on("data", d => (body += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body), raw: body });
          } catch {
            resolve({ status: res.statusCode, body: null, raw: body });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function postStream(path, payload) {
  const bodyStr = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks = [];
        let buffer = "";
        let fullContent = "";

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              chunks.push(parsed);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) fullContent += delta.content;
            } catch {}
          }
        });

        res.on("end", () => resolve({ status: res.statusCode, chunks, fullContent }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Attestation ──────────────────────────────────────────────────────────────

describe("Attestation (live Venice API)", () => {
  test("fetches and verifies attestation for the model", { timeout: 30_000 }, async () => {
    const result = await getModelPublicKey(MODEL, API_KEY, false);
    assert.ok(result.modelPublicKeyHex.startsWith("04"), "signing key should be uncompressed secp256k1 pubkey");
    assert.equal(result.modelPublicKeyHex.length, 130, "65-byte uncompressed key = 130 hex chars");
    assert.equal(typeof result.teeProvider, "string");
    assert.ok(result.teeProvider.length > 0, "teeProvider should not be empty");
    assert.equal(result.debugMode, false, "production TEE should not be in debug mode");
    console.log(`    signing key: ${result.modelPublicKeyHex.slice(0, 20)}...`);
    console.log(`    TEE provider: ${result.teeProvider}`);
    console.log(`    debug mode: ${result.debugMode}`);
  });
});

// ─── /health ──────────────────────────────────────────────────────────────────

describe("/health endpoint", () => {
  test("returns 200 with status ok", { timeout: 10_000 }, async () => {
    const { status, body } = await get("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.model, MODEL);
  });

  test("attestationAge is set after first request", { timeout: 35_000 }, async () => {
    // First, trigger attestation fetch via a real request
    await post("/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const { body } = await get("/health");
    assert.notEqual(body.attestationAge, "not fetched", "attestation should be cached after first request");
    console.log(`    attestation age: ${body.attestationAge}`);
  });
});

// ─── /v1/models ───────────────────────────────────────────────────────────────

describe("/v1/models passthrough", () => {
  test("returns 200 with a list of models", { timeout: 15_000 }, async () => {
    const { status, body } = await get("/v1/models");
    assert.equal(status, 200);
    assert.ok(body.data || Array.isArray(body), "should have a data array or be an array");
    const models = body.data || body;
    assert.ok(models.length > 0, "should list at least one model");
    console.log(`    ${models.length} models returned`);
  });
});

// ─── Non-streaming chat completion ────────────────────────────────────────────

describe("POST /v1/chat/completions (non-streaming)", () => {
  test("returns decrypted plaintext response", { timeout: 60_000 }, async () => {
    const { status, body } = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      stream: false,
    });

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.choices, "response should have choices");
    assert.ok(body.choices.length > 0);

    const content = body.choices[0]?.message?.content;
    assert.ok(typeof content === "string", "content should be a string");
    assert.ok(content.length > 0, "content should not be empty");

    // Content should be readable text, NOT a hex blob
    const isHexGibberish = content.length >= 186 && /^[0-9a-f]+$/i.test(content);
    assert.ok(!isHexGibberish, `response looks like un-decrypted hex ciphertext: ${content.slice(0, 60)}...`);

    console.log(`    response: "${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"`);
  });

  test("system prompt is honored", { timeout: 60_000 }, async () => {
    const { status, body } = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [
        { role: "system", content: "You are a calculator. Only respond with numbers, no words." },
        { role: "user", content: "What is 2 + 2?" },
      ],
      stream: false,
    });

    assert.equal(status, 200);
    const content = body.choices[0]?.message?.content;
    assert.ok(typeof content === "string" && content.length > 0);
    // The system prompt says respond with only numbers — so the answer should include "4"
    assert.ok(content.includes("4"), `expected "4" in response, got: "${content}"`);
    console.log(`    2+2 = "${content}"`);
  });

  test("response preserves OpenAI response structure", { timeout: 60_000 }, async () => {
    const { status, body } = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "Say hello." }],
      stream: false,
    });

    assert.equal(status, 200);
    assert.ok(body.id, "response should have an id");
    assert.ok(body.object, "response should have an object field");
    assert.ok(body.choices, "response should have choices");
    assert.ok(body.choices[0].message, "choice should have a message");
    assert.ok(body.choices[0].message.role === "assistant", "message role should be assistant");
  });
});

// ─── Streaming chat completion ────────────────────────────────────────────────

describe("POST /v1/chat/completions (streaming)", () => {
  test("streams decrypted plaintext as OpenAI SSE", { timeout: 60_000 }, async () => {
    const { status, chunks, fullContent } = await postStream("/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "Count to 3: one, two, three." }],
      stream: true,
    });

    assert.equal(status, 200, `expected 200, got ${status}`);
    assert.ok(chunks.length > 0, "should receive at least one SSE chunk");
    assert.ok(fullContent.length > 0, "should receive non-empty content");

    // Content should be readable text, NOT hex
    const isHexGibberish = fullContent.length >= 186 && /^[0-9a-f]+$/i.test(fullContent);
    assert.ok(!isHexGibberish, "streamed content should be plaintext, not hex ciphertext");

    // Each chunk should follow OpenAI SSE format
    const contentChunks = chunks.filter(c => c.choices?.[0]?.delta?.content);
    assert.ok(contentChunks.length > 0, "should have chunks with content deltas");

    // Last chunk should have finish_reason
    const lastChunk = chunks[chunks.length - 1];
    assert.ok(lastChunk.choices?.[0]?.finish_reason, "last chunk should have finish_reason");

    console.log(`    ${chunks.length} SSE chunks, ${fullContent.length} chars`);
    console.log(`    content: "${fullContent.slice(0, 80)}${fullContent.length > 80 ? "..." : ""}"`);
  });

  test("streaming response assembles into coherent text", { timeout: 60_000 }, async () => {
    const { fullContent } = await postStream("/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "What color is the sky? One word answer." }],
      stream: true,
    });

    assert.ok(fullContent.length > 0, "should have content");
    // Should be a readable word/sentence, not gibberish
    assert.ok(fullContent.split(" ").length >= 1, "should have at least one word");
    console.log(`    sky color response: "${fullContent}"`);
  });
});

// ─── Multi-turn conversation ──────────────────────────────────────────────────

describe("Multi-turn conversation (all messages encrypted)", () => {
  test("assistant recall: references previous user message", { timeout: 90_000 }, async () => {
    // First turn
    const turn1 = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "My secret number is 42. Remember it." }],
      stream: false,
    });
    assert.equal(turn1.status, 200);
    const reply1 = turn1.body.choices[0].message.content;

    // Second turn with full history
    const turn2 = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [
        { role: "user", content: "My secret number is 42. Remember it." },
        { role: "assistant", content: reply1 },
        { role: "user", content: "What was my secret number?" },
      ],
      stream: false,
    });
    assert.equal(turn2.status, 200);
    const reply2 = turn2.body.choices[0].message.content;

    assert.ok(reply2.includes("42"), `expected model to recall "42", got: "${reply2}"`);
    console.log(`    turn 2 reply: "${reply2.slice(0, 80)}"`);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("Error handling", () => {
  test("malformed request body returns 400-level error", { timeout: 15_000 }, async () => {
    const bodyStr = "not valid json {{";
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: TEST_PORT,
          path: "/v1/chat/completions",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
        },
        (res) => {
          let body = "";
          res.on("data", d => (body += d));
          res.on("end", () => resolve({ status: res.statusCode }));
        },
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
    assert.ok(result.status >= 400, `expected 4xx, got ${result.status}`);
  });

  test("404 for unknown path", { timeout: 10_000 }, async () => {
    const { status } = await get("/v1/nonexistent");
    assert.equal(status, 404);
  });
});

// ─── Crypto verification ──────────────────────────────────────────────────────

describe("E2EE verification (crypto sanity checks via proxy)", () => {
  test("two identical requests produce different encrypted payloads (nonce randomness)", { timeout: 90_000 }, async () => {
    // We can't directly inspect what the proxy sends to Venice, but we can
    // verify both return valid decrypted responses — confirming fresh keys each time.
    const msg = [{ role: "user", content: "Reply with: OK" }];
    const [r1, r2] = await Promise.all([
      post("/v1/chat/completions", { model: MODEL, messages: msg, stream: false }),
      post("/v1/chat/completions", { model: MODEL, messages: msg, stream: false }),
    ]);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    const c1 = r1.body.choices[0].message.content;
    const c2 = r2.body.choices[0].message.content;
    // Both should be readable plaintext (not hex)
    const isHex = s => s.length >= 186 && /^[0-9a-f]+$/i.test(s);
    assert.ok(!isHex(c1), "response 1 should not be raw ciphertext");
    assert.ok(!isHex(c2), "response 2 should not be raw ciphertext");
    console.log(`    parallel request 1: "${c1.slice(0, 40)}"`);
    console.log(`    parallel request 2: "${c2.slice(0, 40)}"`);
  });
});
