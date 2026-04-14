# PLAN.md — venice-e2ee-proxy

## What we're building

A Node.js/TypeScript local proxy server that:
1. Listens on localhost (default: 3333) as an OpenAI-compatible HTTP server
2. Intercepts chat completion requests
3. Encrypts them using Venice's E2EE protocol (secp256k1 ECDH + HKDF-SHA256 + AES-128-GCM)
4. Forwards to Venice API with TEE headers
5. Decrypts the encrypted response chunks
6. Returns plaintext back to the caller

The caller (Cursor, Claude Code, any OpenAI SDK) is completely unaware of E2EE — it just works.

---

## Protocol reference

Venice E2EE protocol (from veniceai/venice-cli source + our working implementation in zkllmapi-v2):

**Encryption (per message):**
```
ephemeralPriv = secp256k1.generatePrivateKey()
ephemeralPub  = secp256k1.getPublicKey(ephemeralPriv)  // 65 bytes uncompressed
sharedSecret  = ECDH(ephemeralPriv, modelPublicKey)    // x-coordinate only (32 bytes)
aesKey        = HKDF-SHA256(sharedSecret, info="ecdsa_encryption", len=32)
nonce         = randomBytes(12)
ciphertext    = AES-128-GCM.encrypt(plaintext, aesKey, nonce)
wire          = hex(ephemeralPub[65] || nonce[12] || ciphertext+tag)
```

**Decryption (response chunks):**
```
raw           = hexToBytes(chunk)
serverPub     = raw[0:65]
nonce         = raw[65:77]
ciphertext    = raw[77:]
sharedSecret  = ECDH(clientPriv, serverPub)
aesKey        = HKDF-SHA256(sharedSecret, info="ecdsa_encryption", len=32)
plaintext     = AES-128-GCM.decrypt(ciphertext, aesKey, nonce)
```

**TEE Headers to send:**
```
X-Venice-TEE-Client-Pub-Key: <client ephemeral pubkey hex>
X-Venice-TEE-Model-Pub-Key:  <model signing key from attestation hex>
X-Venice-TEE-Signing-Algo:   ecdsa
```

**Attestation endpoint:**
```
GET https://api.venice.ai/api/v1/tee/attestation?model=<model>&nonce=<32-byte-hex>
Response: { nonce, verified, signing_key, intel_quote, nvidia_payload, server_verification }
```

---

## Architecture

```
src/
├── index.ts          — CLI entrypoint (parse args, start server)
├── server.ts         — Express server, OpenAI-compatible routes
├── e2ee.ts           — Encryption/decryption (port from venice-cli)
├── attestation.ts    — Fetch + verify + cache TEE attestation
└── proxy.ts          — Forward request to Venice, handle streaming response
```

---

## Implementation steps

### Step 1 — Project scaffold
- `package.json` with deps: express, @noble/curves, @noble/hashes, @noble/ciphers, commander, node-fetch
- TypeScript config
- Build script: `tsc` → `dist/`
- Binary: `venice-e2ee-proxy` pointing at `dist/index.js`

### Step 2 — E2EE crypto (`e2ee.ts`)
Port from our working `zkllmapi-v2/packages/nextjs/utils/e2ee.ts`:
- `encryptMessage(plaintext, modelPubKeyHex) → hexString`
- `encryptMessages(messages[], modelPubKeyHex) → messages[]`
- `generateClientKeypair() → { privateKey, publicKeyHex }`
- `decryptChunk(hexCiphertext, clientPrivKey) → string`
- `decryptResponseChunks(chunks[], clientPrivKey) → string`
- `buildE2EEHeaders(clientPubKeyHex, modelPubKeyHex) → headers`

### Step 3 — Attestation (`attestation.ts`)
- `fetchAttestation(model, apiKey) → AttestationResult`
- Verify: `nonce` matches, `verified === true`, signing key present
- Cache with 10-minute TTL
- On startup: pre-warm the cache

### Step 4 — Server (`server.ts`)
OpenAI-compatible endpoints:
- `POST /v1/chat/completions` — main path, handles both streaming and non-streaming
- `GET /v1/models` — passthrough to Venice
- `GET /health` — local health check

Request flow for `POST /v1/chat/completions`:
1. Parse incoming JSON (model, messages, stream flag)
2. Get cached attestation (or fetch fresh)
3. Generate fresh client keypair for this request
4. Encrypt all messages (user + system + assistant) with model pubkey
5. Build TEE headers
6. If stream=true: use streaming Venice API, collect encrypted SSE chunks, decrypt each, stream plaintext back
7. If stream=false: send to Venice, decrypt response content field

### Step 5 — Streaming handling
Venice E2EE streaming returns encrypted chunks in SSE format.
The response has `encrypted_chunks` or similar. Need to:
- Collect all chunks (or decrypt per-chunk for low latency)
- Reconstruct the plaintext
- Re-emit as proper OpenAI SSE chunks to the caller

**Note:** Check Venice actual streaming E2EE response format. From our backend logs: `E2EE stream: collected 275 encrypted chunks` — the backend collects all then decrypts. For the proxy we should do the same for safety, then stream the plaintext back in OpenAI SSE format.

### Step 6 — CLI (`index.ts`)
```
venice-e2ee-proxy [options]
  --key <key>         Venice API key (or VENICE_API_KEY env)
  --port <port>       Port to listen on (default: 3333)
  --model <model>     E2EE model (default: e2ee-glm-5)
  --no-verify         Skip attestation verification
  --verbose           Log encrypted/decrypted content sizes
```

### Step 7 — Test
- Manual test: `npx openai` or curl against localhost:3333
- Check logs to confirm E2EE headers sent and chunks decrypted

### Step 8 — Package + publish
- `npm publish` as `venice-e2ee-proxy`
- GitHub: `clawdbotatg/venice-e2ee-proxy`

---

## Key decisions

1. **All message roles encrypted** — Venice returns 400 if you send mixed plaintext/ciphertext. Encrypt system, user, AND assistant messages.
2. **Per-request client keypair** — fresh keypair per request for forward secrecy
3. **Attestation cached 10 min** — model signing key doesn't change frequently; fetching per-request would be slow
4. **localhost only by default** — bind to 127.0.0.1, not 0.0.0.0, for security
5. **Non-streaming collect-then-stream** — collect all encrypted chunks, decrypt, then stream plaintext back as SSE. Avoids partial decrypt issues.

---

## Dependencies

```json
{
  "@noble/ciphers": "^0.6.0",
  "@noble/curves": "^1.4.0",
  "@noble/hashes": "^1.4.0",
  "commander": "^12.0.0",
  "express": "^4.18.0"
}
```

No heavy deps. Pure TypeScript. No Rust, no WASM, no Barretenberg. Ships as a simple npm package.

---

## What success looks like

```bash
$ venice-e2ee-proxy --key sk-venice-xxx
🔐 venice-e2ee-proxy v1.0.0
✓ Attestation verified for e2ee-glm-5
  Signing key: 0459e5d3f743827f...
  TEE provider: NEAR AI Cloud
  TDX debug mode: No
🚀 Listening on http://localhost:3333
   Point any OpenAI-compatible tool here.
   Your prompts are E2EE to Venice's TEE.

[req] POST /v1/chat/completions (stream=true)
[e2ee] encrypted 3 messages → 3 hex blobs
[e2ee] collected 112 encrypted chunks → decrypted 847 chars
[req] done in 3.2s
```
