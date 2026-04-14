#!/usr/bin/env node
/**
 * index.ts — CLI entrypoint for venice-e2ee-proxy
 */
import * as dotenv from "dotenv";
dotenv.config({ quiet: true }); // load .env — quiet suppresses dotenv's own stdout logging

import { Command } from "commander";
import { getModelPublicKey } from "./attestation";
import { fetchE2EEModels, printModelTable } from "./models";
import { createServer } from "./server";

process.on("unhandledRejection", (err) => {
  console.error("[fatal] Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
});

const program = new Command();

program
  .name("venice-e2ee-proxy")
  .description("Local OpenAI-compatible proxy with transparent E2EE to Venice AI TEE models")
  .version("1.0.0")
  .option("-k, --key <key>", "Venice API key (or VENICE_API_KEY env)")
  .option("-p, --port <port>", "Port to listen on", "3333")
  .option("-m, --model <model>", "E2EE model to use", "e2ee-glm-5")
  .option("--list-models", "List available E2EE models and exit")
  .option("--no-verify", "Skip attestation verification (dev only)")
  .option("--verbose", "Verbose logging", false)
  .action(async (opts) => {
    const apiKey = opts.key || process.env.VENICE_API_KEY;
    if (!apiKey) {
      console.error("Error: Venice API key required. Use --key or VENICE_API_KEY env.");
      process.exit(1);
    }

    // --list-models: fetch live model list, print, exit
    if (opts.listModels) {
      try {
        console.log("   Fetching available E2EE models from Venice...");
        const models = await fetchE2EEModels(apiKey);
        printModelTable(models);
      } catch (err: any) {
        console.error(`Error fetching models: ${err.message}`);
        process.exit(1);
      }
      process.exit(0);
    }

    const port = parseInt(opts.port, 10);
    const model = opts.model;
    const verbose = opts.verbose;

    if (!model.startsWith("e2ee-")) {
      console.warn(`⚠  Warning: "${model}" doesn't look like an E2EE model (expected e2ee-* prefix).`);
      console.warn(`   Run with --list-models to see available E2EE models.`);
    }

    console.log(`🔐 venice-e2ee-proxy v1.0.0`);
    console.log(`   Model: ${model}`);

    // Pre-fetch attestation
    try {
      console.log(`   Fetching TEE attestation...`);
      const attestation = await getModelPublicKey(model, apiKey, true);
      console.log(`✓  Attestation verified for ${model}`);
      console.log(`   Signing key: ${attestation.modelPublicKeyHex.slice(0, 20)}...`);
      console.log(`   TEE provider: ${attestation.teeProvider}`);
      console.log(`   TDX debug mode: ${attestation.debugMode ? "Yes ⚠️" : "No"}`);
    } catch (err: any) {
      console.error(`✗  Failed to fetch attestation: ${err.message}`);
      if (opts.verify !== false) {
        console.error("   Exiting. Use --no-verify to skip.");
        process.exit(1);
      }
      console.warn("   Continuing without attestation (--no-verify)");
    }

    // Start server
    const app = createServer({ apiKey, port, model, verbose });

    app.listen(port, "127.0.0.1", () => {
      console.log(`\n🚀 Listening on http://localhost:${port}`);
      console.log(`   Point any OpenAI-compatible tool here.`);
      console.log(`   Your prompts are E2EE to Venice's TEE.\n`);
    });
  });

program.parse();
