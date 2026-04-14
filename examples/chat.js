#!/usr/bin/env node
/**
 * examples/chat.js
 *
 * Interactive E2EE chat REPL — talks to venice-e2ee-proxy on localhost.
 * Start the proxy first: venice-e2ee-proxy
 * Then run: node examples/chat.js
 */

const readline = require("readline");
const http = require("http");

const PROXY_URL = process.env.PROXY_URL || "http://localhost:3333";
const MODEL = process.env.MODEL || "e2ee-glm-5";

const history = [];

const RESET  = "\x1b[0m";
const DIM    = "\x1b[2m";
const BOLD   = "\x1b[1m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RED    = "\x1b[31m";
const GRAY   = "\x1b[90m";

// ── Spinner ───────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

function startSpinner(label) {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${GRAY}${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]}  ${label}${RESET}`);
  }, 80);
  return function stop() {
    clearInterval(id);
    process.stdout.write("\r\x1b[K"); // clear line
  };
}

// ── Health check ──────────────────────────────────────────────────────────────

async function checkProxy() {
  return new Promise((resolve) => {
    http
      .get(`${PROXY_URL}/health`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        });
      })
      .on("error", () => resolve(null));
  });
}

// ── Stream a chat completion ──────────────────────────────────────────────────

async function streamChat(messages) {
  const body = JSON.stringify({ model: MODEL, messages, stream: true });
  const url = new URL(`${PROXY_URL}/v1/chat/completions`);

  return new Promise((resolve, reject) => {
    let fullContent = "";
    let buffer = "";
    let headerPrinted = false;

    // Start spinner now — before the request even goes out
    let stopSpinner = startSpinner("thinking...");

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          if (stopSpinner) { stopSpinner(); stopSpinner = null; }
          let errBody = "";
          res.on("data", (d) => (errBody += d));
          res.on("end", () => reject(new Error(`Proxy error ${res.statusCode}: ${errBody}`)));
          return;
        }

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
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                if (stopSpinner) { stopSpinner(); stopSpinner = null; }
                if (!headerPrinted) {
                  process.stdout.write(`\n${GREEN}${BOLD}assistant${RESET} ${GRAY}🔐 e2ee${RESET}  `);
                  headerPrinted = true;
                }
                process.stdout.write(delta.content);
                fullContent += delta.content;
              }
              // reasoning_content is intentionally skipped (internal thinking)
            } catch {}
          }
        });

        res.on("end", () => {
          if (stopSpinner) { stopSpinner(); stopSpinner = null; }
          if (!headerPrinted) {
            process.stdout.write(`\n${GREEN}${BOLD}assistant${RESET} ${GRAY}🔐 e2ee${RESET}  ${DIM}(no response)${RESET}`);
          }
          process.stdout.write("\n\n");
          resolve(fullContent);
        });

        res.on("error", (err) => {
          if (stopSpinner) { stopSpinner(); stopSpinner = null; }
          reject(err);
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── REPL ─────────────────────────────────────────────────────────────────────

async function main() {
  const health = await checkProxy();
  if (!health) {
    console.error(`\n${RED}✗  Cannot reach proxy at ${PROXY_URL}${RESET}`);
    console.error(`   Start it first: ${DIM}venice-e2ee-proxy${RESET}\n`);
    process.exit(1);
  }

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
    rl.question(`${CYAN}${BOLD}❯${RESET}  `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) { prompt(); return; }

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
            const preview = msg.content.slice(0, 80);
            console.log(`  ${label}${msg.role}:${RESET} ${preview}${msg.content.length > 80 ? "…" : ""}`);
          }
        }
        console.log();
        prompt();
        return;
      }

      history.push({ role: "user", content: trimmed });

      try {
        const reply = await streamChat(history);
        if (reply) history.push({ role: "assistant", content: reply });
      } catch (err) {
        console.error(`\n${RED}error: ${err.message}${RESET}\n`);
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
