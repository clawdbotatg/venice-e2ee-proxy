# venice-e2ee-proxy

A local OpenAI-compatible proxy that adds transparent end-to-end encryption to every request you send to Venice AI's TEE models.

```
Your tool (Cursor, Claude Code, any OpenAI SDK)
        │
        ▼  http://localhost:3333  (plaintext — stays on your machine)
┌──────────────────────────┐
│   venice-e2ee-proxy      │
│  • fetches TEE attestation│
│  • verifies signing key  │
│  • encrypts your prompt  │
│  • decrypts the response │
└──────────┬───────────────┘
           │  HTTPS + E2EE ciphertext
           ▼
     api.venice.ai
           │
           ▼
    Venice TEE enclave  ← only place that ever sees plaintext
```

**Point any OpenAI-compatible tool at `http://localhost:3333` and your prompts are end-to-end encrypted to Venice's TEE. Venice's own infrastructure never sees your plaintext.**

## Why this exists

Venice launched TEE + E2EE inference in March 2026. Their web UI does E2EE. Their CLI (`veniceai-cli`) does E2EE. But if you want to use Cursor, Claude Code, or any tool that speaks the OpenAI API — you're sending plaintext to Venice. This proxy closes that gap.

## How it works

1. On startup, fetches TEE attestation from Venice for your chosen model
2. Verifies the attestation (Intel TDX quote + NVIDIA GPU attestation + nonce binding)
3. Caches the model's signing key (refreshes every 10 minutes)
4. For every incoming request: generates a fresh ephemeral keypair, encrypts ALL messages using secp256k1 ECDH + HKDF-SHA256 + AES-128-GCM
5. Forwards encrypted payload to Venice with the correct TEE headers
6. Decrypts the encrypted response (content + reasoning_content)
7. Returns plaintext to your tool — it never knows E2EE happened

### E2EE Protocol Details

**Encryption (per message):**
- Generate ephemeral secp256k1 keypair
- ECDH shared secret with model's public key (x-coordinate only)
- HKDF-SHA256 with info=`"ecdsa_encryption"`, output=32 bytes
- AES-128-GCM encrypt with 12-byte random nonce
- Wire format (hex): `ephemeralPub[65 bytes] || nonce[12 bytes] || ciphertext+tag`

**All message roles are encrypted** (system, user, assistant). Venice returns 400 if you send mixed plaintext/ciphertext.

**Streaming responses:** Venice sends each SSE chunk with independently encrypted `delta.content` and `delta.reasoning_content` fields. The proxy collects all chunks, decrypts each one individually, then re-emits as standard OpenAI SSE to the caller.

**Non-streaming responses:** The response has encrypted `content` and `reasoning_content` fields, each a single hex blob. The proxy decrypts both and returns standard OpenAI JSON.

## Quick start

```bash
# Clone and build
git clone https://github.com/clawdbotatg/venice-e2ee-proxy.git
cd venice-e2ee-proxy
npm install
npm run build

# Configure
cp .env.example .env
# Edit .env and add your Venice API key (https://venice.ai/settings/api)

# Run
node dist/index.js
```

That's it. Every tool you point at `http://localhost:3333` will have transparent E2EE — no key passing required downstream.

Then point your tool at `http://localhost:3333`:

```bash
# OpenAI SDK
from openai import OpenAI
client = OpenAI(api_key="your-venice-key", base_url="http://localhost:3333/v1")
response = client.chat.completions.create(
    model="e2ee-glm-5",
    messages=[{"role": "user", "content": "Hello!"}]
)

# curl
curl http://localhost:3333/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"e2ee-glm-5","messages":[{"role":"user","content":"Hello!"}]}'

# Cursor / any OpenAI-compatible tool
# Set base URL to: http://localhost:3333/v1
```

## Options

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--key` | `VENICE_API_KEY` | required | Your Venice API key |
| `--port` | — | `3333` | Local port to listen on |
| `--model` | — | `e2ee-glm-5` | Venice E2EE model to use |
| `--no-verify` | — | false | Skip attestation verification (dev only) |
| `--verbose` | — | false | Log encryption/decryption details |

## Available E2EE Models

Venice offers several E2EE models:
- `e2ee-glm-5` (default) — GLM-5
- `e2ee-glm-4-7-p` — GLM 4.7
- `e2ee-glm-4-7-flash-p` — GLM 4.7 Flash
- `e2ee-gemma-3-27b-p` — Gemma 3 27B
- `e2ee-venice-uncensored-24b-p` — Venice Uncensored 24B
- `e2ee-gpt-oss-20b-p` — GPT-OSS 20B
- `e2ee-gpt-oss-120b-p` — GPT-OSS 120B
- `e2ee-qwen-2-5-7b-p` — Qwen 2.5 7B
- `e2ee-qwen3-30b-a3b-p` — Qwen 3 30B
- `e2ee-qwen3-5-122b-a10b` — Qwen 3.5 122B

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | E2EE proxy — encrypts request, decrypts response |
| `/v1/models` | GET | Passthrough to Venice (no E2EE) |
| `/health` | GET | Health check with attestation age |

## Security model

- **Your prompts never leave your machine unencrypted.** The proxy encrypts before sending over the network.
- **Venice's infrastructure never sees plaintext.** Only the TEE enclave decrypts.
- **The attestation is verified.** The proxy checks the Intel TDX nonce binding and `verified` flag before trusting the model's public key.
- **Per-request ephemeral keys.** Each request uses a fresh ECDH keypair — no key reuse.
- **The proxy is local.** It binds to `127.0.0.1` only — not accessible from the network.

## Architecture

```
src/
├── index.ts          — CLI entrypoint (Commander, startup banner)
├── server.ts         — Express server, OpenAI-compatible routes
├── e2ee.ts           — Encryption/decryption (secp256k1 + HKDF + AES-GCM)
├── attestation.ts    — Fetch + verify + cache TEE attestation
└── proxy.ts          — Forward to Venice, handle streaming/non-streaming responses
```

## Dependencies

Minimal, auditable dependencies:
- `@noble/curves` — secp256k1 ECDH
- `@noble/hashes` — HKDF-SHA256
- `@noble/ciphers` — AES-GCM
- `express` — HTTP server
- `commander` — CLI parsing

No heavy frameworks. No WASM. No native modules.

## License

MIT
