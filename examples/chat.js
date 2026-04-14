#!/usr/bin/env node
/**
 * examples/chat.js
 *
 * Interactive E2EE chat REPL — talks to venice-e2ee-proxy on localhost.
 * Start the proxy first: node dist/index.js
 * Then run: node examples/chat.js
 */

const readline = require("readline");
const http = require("http");

const PROXY_URL = process.env.PROXY_URL || "http://localhost:3333";
const MODEL = process.env.MODEL || "e2ee-glm-5";

const history = [];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";

// ── Check proxy is running ────────────────────────────────────────────────────

async function checkProxy() {
  return new Promise((resolve) => {
    http
      .get(`${PROXY_URL}/health`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}

// ── Stream a chat completion from the proxy ──────────────────────────────────

async function streamChat(messages) {
  const body = JSON.stringify({ model: MODEL, messages, stream: true });
  const url = new URL(`${PROXY_URL}/v1/chat/completions`);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: "Bearer local",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (d) => (errBody += d));
          res.on("end", () => reject(new Error(`Proxy error ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullContent = "";
        let buffer = "";

        process.stdout.write(`\n${GREEN}${BOLD}assistant${RESET} ${DIM}🔐 e2ee${RESET}  `);

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                process.stdout.write(delta.content);
                fullContent += delta.content;
              }
              // Skip reasoning_content — don't show thinking noise in the REPL
            } catch {
              // ignore parse errors
            }
          }
        });

        res.on("end", () => {
          process.stdout.write("\n\n");
          resolve(fullContent);
        });

        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── REPL ─────────────────────────────────────────────────────────────────────

async function main() {
  // Check proxy
  const health = await checkProxy();
  if (!health) {
    console.error(`\n${RED}✗ Cannot reach proxy at ${PROXY_URL}${RESET}`);
    console.error(`  Start it first: ${DIM}node dist/index.js${RESET}\n`);
    process.exit(1);
  }

  // Banner
  console.clear();
  console.log(`${BOLD}${MAGENTA}┌─────────────────────────────────────────┐${RESET}`);
  console.log(`${BOLD}${MAGENTA}│  🔐  venice-e2ee-proxy  —  chat REPL    │${RESET}`);
  console.log(`${BOLD}${MAGENTA}└─────────────────────────────────────────┘${RESET}`);
  console.log();
  console.log(`  ${DIM}proxy:${RESET}  ${PROXY_URL}`);
  console.log(`  ${DIM}model:${RESET}  ${MODEL}`);
  console.log(`  ${DIM}e2ee:${RESET}   ${GREEN}active${RESET} — attestation age ${health.attestationAge}`);
  console.log();
  console.log(`  ${DIM}type a message and press enter. ctrl+c to quit.${RESET}`);
  console.log(`  ${DIM}commands: /clear  /history  /quit${RESET}`);
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    rl.question(`${CYAN}${BOLD}you${RESET}  `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Commands
      if (trimmed === "/quit" || trimmed === "/exit") {
        console.log(`\n${DIM}bye.${RESET}\n`);
        rl.close();
        process.exit(0);
      }

      if (trimmed === "/clear") {
        history.length = 0;
        console.clear();
        console.log(`${DIM}conversation cleared.${RESET}\n`);
        prompt();
        return;
      }

      if (trimmed === "/history") {
        console.log();
        if (history.length === 0) {
          console.log(`  ${DIM}(empty)${RESET}`);
        } else {
          for (const msg of history) {
            const label = msg.role === "user" ? CYAN : GREEN;
            console.log(`  ${label}${msg.role}:${RESET} ${msg.content.slice(0, 80)}${msg.content.length > 80 ? "…" : ""}`);
          }
        }
        console.log();
        prompt();
        return;
      }

      // Add to history and send
      history.push({ role: "user", content: trimmed });

      try {
        const reply = await streamChat(history);
        if (reply) {
          history.push({ role: "assistant", content: reply });
        }
      } catch (err) {
        console.error(`\n${RED}error: ${err.message}${RESET}\n`);
        // Pop the user message so they can retry
        history.pop();
      }

      prompt();
    });
  };

  rl.on("close", () => {
    console.log(`\n${DIM}bye.${RESET}\n`);
    process.exit(0);
  });

  prompt();
}

main();
