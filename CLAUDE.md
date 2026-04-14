# venice-e2ee-proxy

Local OpenAI-compatible proxy that adds transparent E2EE to Venice AI TEE models. Any tool pointing at `http://localhost:3333` gets encrypted prompts/responses without knowing about E2EE.

## Commands

```bash
npm run build           # compile TypeScript → dist/
npm test                # unit tests (no network, always runnable)
npm run test:integration  # live Venice API tests (needs VENICE_API_KEY)
npm run test:all          # both

node dist/index.js                         # start with defaults (e2ee-glm-5, port 3333)
node dist/index.js --list-models           # show available E2EE models + pricing
node dist/index.js --model e2ee-gpt-oss-20b-p  # use a different model
node dist/index.js --verbose               # log encryption details
node dist/index.js --no-verify             # skip attestation (dev only)
```

API key goes in `.env` as `VENICE_API_KEY` (already in .gitignore).

## File structure

```
src/
├── index.ts       — CLI (Commander, dotenv, --list-models, validation, startup banner)
├── server.ts      — Express: /health, GET /v1/models (E2EE only), POST /v1/chat/completions
├── e2ee.ts        — All crypto: encryptMessages, decryptChunk, decryptResponseContent, buildE2EEHeaders
├── attestation.ts — TEE attestation fetch/verify/cache (10-min TTL, nonce binding check)
├── models.ts      — fetchE2EEModels() + printModelTable() for --list-models
└── proxy.ts       — Forward to Venice, collect+decrypt SSE, re-emit as OpenAI SSE
examples/
└── chat.js        — Interactive REPL (node examples/chat.js, set MODEL env to switch)
tests/
├── unit/e2ee.test.js         — 33 pure crypto tests, no network
├── unit/attestation.test.js  — 22 mock-fetch attestation tests
└── integration/proxy.test.js — live Venice API tests, skips if no VENICE_API_KEY
```

## E2EE protocol

**Encrypt (per message):** ephemeral secp256k1 keypair → ECDH(ephemeralPriv, modelPub) → HKDF-SHA256(shared, info="ecdsa_encryption", len=32) → AES-128-GCM. Wire format (hex): `ephemeralPub[65] || nonce[12] || ciphertext+tag`.

**Decrypt (response):** parse wire → ECDH(clientPriv, serverEphemeralPub) → same KDF → AES-GCM decrypt.

**Required TEE headers:** `X-Venice-TEE-Client-Pub-Key`, `X-Venice-TEE-Model-Pub-Key`, `X-Venice-TEE-Signing-Algo: ecdsa`.

**All message roles must be encrypted** — Venice returns 400 for mixed plaintext/ciphertext.

## Key design decisions

- **Streaming = collect-all-then-re-emit.** The proxy buffers all encrypted SSE chunks from Venice, decrypts the full blob, then re-emits as OpenAI SSE. This means the caller doesn't see tokens until the full response is ready. Known tradeoff — avoids partial-decrypt issues.
- **Fresh client keypair per request** — forward secrecy.
- **Attestation cached 10 minutes** — nonce-bound so MITM is detectable; refreshes automatically.
- **Binds to 127.0.0.1 only** — not exposed to the network.
- **`/v1/models` returns E2EE models only** — filters Venice's full catalog to `supportsE2EE: true`.

## E2EE models

Fetched live from Venice: `node dist/index.js --list-models`. Currently ~11 models including `e2ee-qwen3-5-122b-a10b` (reasoning+vision+tools, 128K), `e2ee-qwen3-30b-a3b-p` (256K context, cheapest with tools), `e2ee-gpt-oss-20b-p` (cheapest with reasoning). Default is `e2ee-glm-5`.

## Dependencies

`@noble/curves`, `@noble/hashes`, `@noble/ciphers` (crypto), `express`, `commander`, `dotenv`. No WASM, no native modules.
