/**
 * server.ts — Express server with OpenAI-compatible routes
 */
import express from "express";
import { getModelPublicKey, getAttestationAge } from "./attestation";
import { proxyRequest } from "./proxy";

export interface ServerConfig {
  apiKey: string;
  port: number;
  model: string;
  verbose: boolean;
}

export function createServer(config: ServerConfig): express.Express {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/health", (_req, res) => {
    const age = getAttestationAge(config.model);
    res.json({
      status: "ok",
      model: config.model,
      attestationAge: age !== null ? `${Math.round(age / 1000)}s` : "not fetched",
    });
  });

  // Models — returns only E2EE-capable models
  app.get("/v1/models", async (_req, res) => {
    try {
      const veniceRes = await fetch("https://api.venice.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      const data: any = await veniceRes.json();
      const all: any[] = data.data || data;
      const e2eeModels = all.filter(m => m.model_spec?.capabilities?.supportsE2EE === true);
      res.json({ object: "list", data: e2eeModels });
    } catch (err) {
      console.error("[models] Error fetching models:", err);
      res.status(502).json({ error: { message: "Failed to fetch models from Venice" } });
    }
  });

  // Main E2EE proxy endpoint
  app.post("/v1/chat/completions", async (req, res) => {
    const startTime = Date.now();
    const isStream = req.body?.stream === true;

    if (config.verbose) {
      console.log(`\n[req] POST /v1/chat/completions (stream=${isStream})`);
    }

    try {
      // Get model public key (cached)
      const attestation = await getModelPublicKey(config.model, config.apiKey, config.verbose);

      // Override model in request body to use E2EE model
      const body = { ...req.body, model: config.model };

      await proxyRequest({
        body,
        modelPublicKeyHex: attestation.modelPublicKeyHex,
        apiKey: config.apiKey,
        verbose: config.verbose,
        res,
      });

      if (config.verbose) {
        console.log(`[req] done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      }
    } catch (err: any) {
      console.error(`[req] Error:`, err.message || err);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: err.message || "Internal proxy error",
            type: "proxy_error",
          },
        });
      }
    }
  });

  return app;
}
