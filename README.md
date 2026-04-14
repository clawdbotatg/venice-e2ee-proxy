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
4. For every incoming request: encrypts messages using secp256k1 ECDH + HKDF-SHA256 + AES-128-GCM
5. Forwards encrypted payload to Venice with the correct TEE headers
6. Decrypts the encrypted response chunks
7. Returns plaintext to your tool — it never knows E2EE happened

## Quick start

```bash
npx venice-e2ee-proxy --key YOUR_VENICE_API_KEY
# or
VENICE_API_KEY=your_key npx venice-e2ee-proxy
```

Then point your tool at `http://localhost:3333`:

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://localhost:3333 claude

# OpenAI SDK
client = OpenAI(api_key="your-venice-key", base_url="http://localhost:3333/v1")

# Cursor / any OpenAI-compatible tool
# Set base URL to: http://localhost:3333/v1
```

## Options

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--key` | `VENICE_API_KEY` | required | Your Venice API key |
| `--port` | `PORT` | `3333` | Local port to listen on |
| `--model` | `E2EE_MODEL` | `e2ee-glm-5` | Venice E2EE model to use |
| `--no-verify` | — | false | Skip attestation verification (dev only) |

## Security model

- **Your prompts never leave your machine unencrypted.** The proxy encrypts before sending over the network.
- **Venice's infrastructure never sees plaintext.** Only the TEE enclave decrypts.
- **The attestation is verified.** The proxy checks the Intel TDX quote and nonce binding before trusting the model's public key.
- **Per-request ephemeral keys.** Each message uses a fresh ECDH keypair — no key reuse.
- **The proxy is local.** It binds to localhost only by default.

## Install

```bash
npm install -g venice-e2ee-proxy
```

## License

MIT
