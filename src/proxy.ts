/**
 * proxy.ts — Forward encrypted requests to Venice, handle responses
 */
import type { Response } from "express";
import {
  encryptMessages,
  generateClientKeypair,
  buildE2EEHeaders,
  decryptResponseContent,
  decryptResponseChunks,
} from "./e2ee";

const VENICE_API_URL = "https://api.venice.ai/api/v1/chat/completions";

function decryptCollectedChunks(
  chunks: string[],
  clientPrivateKey: Uint8Array,
  label: string,
  verbose: boolean,
): string {
  if (chunks.length === 0) return "";

  // Strategy 1: Try concatenating all chunks and decrypting as one blob
  const concatenated = chunks.join("");
  try {
    const result = decryptResponseContent(concatenated, clientPrivateKey);
    // Only accept if something was actually decrypted (result changed)
    if (result !== concatenated) {
      if (verbose) {
        console.log(`[e2ee] decrypted ${label} (concatenated) → ${result.length} chars`);
      }
      return result;
    }
  } catch {}

  // Strategy 2: Each chunk is independently encrypted
  try {
    const result = decryptResponseChunks(chunks, clientPrivateKey);
    if (verbose) {
      console.log(`[e2ee] decrypted ${label} (${chunks.length} individual chunks) → ${result.length} chars`);
    }
    return result;
  } catch (err) {
    console.error(`[e2ee] Failed to decrypt ${label}:`, err);
    return concatenated; // Return raw as fallback
  }
}

interface ProxyOptions {
  body: any;
  modelPublicKeyHex: string;
  apiKey: string;
  verbose: boolean;
  res: Response;
}

export async function proxyRequest(opts: ProxyOptions): Promise<void> {
  const { body, modelPublicKeyHex, apiKey, verbose, res } = opts;
  const isStream = body.stream === true;

  // Generate fresh client keypair for this request
  const clientKeypair = generateClientKeypair();

  // Encrypt all messages
  const messages = body.messages || [];
  const encryptedMessages = encryptMessages(messages, modelPublicKeyHex);

  if (verbose) {
    console.log(`[e2ee] encrypted ${messages.length} messages`);
  }

  // Build E2EE headers
  const e2eeHeaders = buildE2EEHeaders(clientKeypair.publicKeyHex, modelPublicKeyHex);

  // Build request body
  const veniceBody = {
    ...body,
    messages: encryptedMessages,
  };

  if (verbose) {
    console.log(`[proxy] POST ${VENICE_API_URL} (stream=${isStream})`);
    console.log(`[proxy] TEE headers:`, Object.keys(e2eeHeaders).join(", "));
  }

  const veniceRes = await fetch(VENICE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...e2eeHeaders,
    },
    body: JSON.stringify(veniceBody),
  });

  if (!veniceRes.ok) {
    const errBody = await veniceRes.text();
    if (verbose) {
      console.error(`[proxy] Venice error (${veniceRes.status}): ${errBody}`);
    } else {
      console.error(`[proxy] Venice error (${veniceRes.status})`);
    }
    res.status(veniceRes.status).json({
      error: {
        message: `Venice API error: ${errBody}`,
        type: "upstream_error",
        code: veniceRes.status,
      },
    });
    return;
  }

  try {
    if (isStream) {
      await handleStreamingResponse(veniceRes, clientKeypair.privateKey, verbose, res);
    } else {
      await handleNonStreamingResponse(veniceRes, clientKeypair.privateKey, verbose, res);
    }
  } catch (err: any) {
    console.error(`[proxy] Error handling Venice response:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: `Proxy error: ${err.message}`, type: "proxy_error" },
      });
    }
  }
}

async function handleNonStreamingResponse(
  veniceRes: globalThis.Response,
  clientPrivateKey: Uint8Array,
  verbose: boolean,
  res: Response,
): Promise<void> {
  const data: any = await veniceRes.json();

  // Check for encrypted_chunks array
  if (data.encrypted_chunks && Array.isArray(data.encrypted_chunks)) {
    const decrypted = decryptResponseChunks(data.encrypted_chunks, clientPrivateKey);
    if (verbose) {
      console.log(`[e2ee] decrypted ${data.encrypted_chunks.length} chunks → ${decrypted.length} chars`);
    }
    // Replace the content with decrypted text
    if (data.choices && data.choices[0] && data.choices[0].message) {
      data.choices[0].message.content = decrypted;
    }
    delete data.encrypted_chunks;
    res.json(data);
    return;
  }

  // Check if message content is hex-encrypted
  if (data.choices && data.choices[0] && data.choices[0].message) {
    const msg = data.choices[0].message;

    // Decrypt main content
    if (typeof msg.content === "string") {
      let content = decryptResponseContent(msg.content, clientPrivateKey);
      // Handle <think>...</think> embedded reasoning
      const thinkMatch = content.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
      if (thinkMatch) {
        msg.reasoning_content = (msg.reasoning_content ?? "") + thinkMatch[1].trim();
        content = thinkMatch[2].trim();
      }
      if (verbose && content !== msg.content) {
        console.log(`[e2ee] decrypted response content: ${content.length} chars`);
      }
      msg.content = content;
    }

    // Decrypt reasoning_content if present
    if (typeof msg.reasoning_content === "string") {
      const decrypted = decryptResponseContent(msg.reasoning_content, clientPrivateKey);
      if (verbose && decrypted !== msg.reasoning_content) {
        console.log(`[e2ee] decrypted reasoning_content: ${decrypted.length} chars`);
      }
      msg.reasoning_content = decrypted;
    }
  }

  res.json(data);
}

async function handleStreamingResponse(
  veniceRes: globalThis.Response,
  clientPrivateKey: Uint8Array,
  verbose: boolean,
  res: Response,
): Promise<void> {
  // Collect all encrypted content chunks from SSE, then decrypt and re-emit
  const body = veniceRes.body;
  if (!body) {
    res.status(500).json({ error: { message: "No response body from Venice" } });
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const encryptedContentChunks: string[] = [];
  const encryptedReasoningChunks: string[] = [];
  let finishReason: string | null = null;
  let completionId = "";
  let model = "";
  let created = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          // Capture metadata from first chunk
          if (!completionId && parsed.id) {
            completionId = parsed.id;
            model = parsed.model || "";
            created = parsed.created || Math.floor(Date.now() / 1000);
          }

          if (parsed.choices && parsed.choices[0]) {
            const choice = parsed.choices[0];

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            if (choice.delta) {
              if (choice.delta.content) {
                encryptedContentChunks.push(choice.delta.content);
              }
              if (choice.delta.reasoning_content) {
                encryptedReasoningChunks.push(choice.delta.reasoning_content);
              }
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } catch (err) {
    console.error(`[proxy] Error reading Venice stream:`, err);
  }

  if (verbose) {
    console.log(`[e2ee] collected ${encryptedContentChunks.length} content chunks, ${encryptedReasoningChunks.length} reasoning chunks`);
  }

  // Decrypt content chunks
  let decryptedContent = decryptCollectedChunks(encryptedContentChunks, clientPrivateKey, "content", verbose);
  let decryptedReasoning = decryptCollectedChunks(encryptedReasoningChunks, clientPrivateKey, "reasoning", verbose);

  // Some models (e.g. GLM-5) embed reasoning as <think>...</think> inside the content field.
  // Extract it and move to reasoning so callers can handle it separately.
  const thinkMatch = decryptedContent.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
  if (thinkMatch) {
    decryptedReasoning = thinkMatch[1].trim() + (decryptedReasoning ? "\n" + decryptedReasoning : "");
    decryptedContent = thinkMatch[2].trim();
  }

  // Re-emit as standard OpenAI SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const id = completionId || `chatcmpl-proxy-${Date.now()}`;
  const ts = created || Math.floor(Date.now() / 1000);
  const mdl = model || "e2ee-glm-5";

  // Emit reasoning first (if any), then content
  if (decryptedReasoning) {
    const chunkSize = 4;
    for (let i = 0; i < decryptedReasoning.length; i += chunkSize) {
      const textChunk = decryptedReasoning.slice(i, i + chunkSize);
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created: ts, model: mdl,
        choices: [{ index: 0, delta: { reasoning_content: textChunk }, finish_reason: null }],
      })}\n\n`);
    }
  }

  // Emit content
  const chunkSize = 4;
  for (let i = 0; i < decryptedContent.length; i += chunkSize) {
    const textChunk = decryptedContent.slice(i, i + chunkSize);
    res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created: ts, model: mdl,
      choices: [{ index: 0, delta: { content: textChunk }, finish_reason: null }],
    })}\n\n`);
  }

  // Send finish chunk
  res.write(`data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created: ts, model: mdl,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }],
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();

  if (verbose) {
    console.log(`[proxy] streamed ${decryptedContent.length} content chars, ${decryptedReasoning.length} reasoning chars`);
  }
}
