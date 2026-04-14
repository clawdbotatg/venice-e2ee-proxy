/**
 * models.ts — Fetch and display available E2EE models from Venice
 */

export interface E2EEModel {
  id: string;
  name: string;
  contextTokens: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  optimizedForCode: boolean;
  supportsFunctionCalling: boolean;
  pricingInputUsd: number;
  pricingOutputUsd: number;
  offline: boolean;
  description: string;
}

export async function fetchE2EEModels(apiKey: string): Promise<E2EEModel[]> {
  const res = await fetch("https://api.venice.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch models (${res.status})`);
  }

  const data: any = await res.json();
  const all: any[] = data.data || data;

  return all
    .filter(m => m.model_spec?.capabilities?.supportsE2EE === true && !m.model_spec?.offline)
    .map(m => ({
      id: m.id,
      name: m.model_spec.name,
      contextTokens: m.model_spec.availableContextTokens ?? 0,
      maxOutputTokens: m.model_spec.maxCompletionTokens ?? 0,
      supportsReasoning: m.model_spec.capabilities.supportsReasoning === true,
      supportsVision: m.model_spec.capabilities.supportsVision === true,
      optimizedForCode: m.model_spec.capabilities.optimizedForCode === true,
      supportsFunctionCalling: m.model_spec.capabilities.supportsFunctionCalling === true,
      pricingInputUsd: m.model_spec.pricing?.input?.usd ?? 0,
      pricingOutputUsd: m.model_spec.pricing?.output?.usd ?? 0,
      offline: m.model_spec.offline === true,
      description: m.model_spec.description ?? "",
    }))
    .sort((a, b) => b.contextTokens - a.contextTokens);
}

export function printModelTable(models: E2EEModel[]): void {
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const CYAN = "\x1b[36m";
  const YELLOW = "\x1b[33m";
  const GREEN = "\x1b[32m";
  const MAGENTA = "\x1b[35m";

  console.log();
  console.log(`${BOLD}🔐 E2EE Models available on Venice${RESET}`);
  console.log(`${DIM}${"─".repeat(80)}${RESET}`);
  console.log();

  // Column widths
  const idW = Math.max(...models.map(m => m.id.length), 4) + 2;
  const nameW = Math.max(...models.map(m => m.name.length), 4) + 2;

  // Header
  console.log(
    `  ${BOLD}${"MODEL ID".padEnd(idW)}${"NAME".padEnd(nameW)}  ${"CTX".padStart(6)}  CAPS          PRICE (per M tok)${RESET}`,
  );
  console.log(`  ${DIM}${"─".repeat(idW + nameW + 42)}${RESET}`);

  for (const m of models) {
    const ctx = m.contextTokens >= 1000
      ? `${Math.round(m.contextTokens / 1000)}K`
      : `${m.contextTokens}`;

    const caps: string[] = [];
    if (m.supportsReasoning) caps.push(`${YELLOW}think${RESET}`);
    if (m.optimizedForCode) caps.push(`${CYAN}code${RESET}`);
    if (m.supportsVision) caps.push(`${MAGENTA}vision${RESET}`);
    if (m.supportsFunctionCalling) caps.push(`${GREEN}tools${RESET}`);
    const capsStr = caps.join(" ").padEnd(caps.length > 0 ? 5 * caps.length + (caps.length - 1) : 0);

    const price = `$${m.pricingInputUsd.toFixed(2)} / $${m.pricingOutputUsd.toFixed(2)}`;

    console.log(
      `  ${CYAN}${m.id.padEnd(idW)}${RESET}${m.name.padEnd(nameW)}  ${ctx.padStart(6)}  ${capsStr.padEnd(30)}  ${DIM}${price}${RESET}`,
    );
  }

  console.log();
  console.log(`${DIM}  Usage: node dist/index.js --model <model-id>${RESET}`);
  console.log(`${DIM}  Example: node dist/index.js --model e2ee-qwen3-5-122b-a10b${RESET}`);
  console.log();
}
