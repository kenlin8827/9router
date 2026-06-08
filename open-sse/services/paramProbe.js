/**
 * Parameter Probe Service
 * 
 * Probes upstream API to detect parameter compatibility per model.
 * Runs asynchronously after request failures to build paramSupport cache.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Parameters to probe - no model pattern filtering, probe all models for all params
// If a param doesn't apply to a model, upstream will reject it and we'll mark as unsupported
const PROBE_PARAMS = [
  { name: "max_completion_tokens", probeBody: { max_completion_tokens: 1 } },
  { name: "reasoning_effort", probeBody: { reasoning_effort: "low" } },
  { name: "thinking", probeBody: { thinking: { type: "enabled", budget_tokens: 100 } } },
  { name: "stream_options", probeBody: { stream: true, stream_options: { include_usage: true } }, streamingOnly: true },
  { name: "response_format.json_schema", probeBody: { response_format: { type: "json_schema", json_schema: { name: "test", schema: { type: "object" } } } } },
  { name: "temperature", probeBody: { temperature: 0.7 } },
  { name: "logprobs", probeBody: { logprobs: true, top_logprobs: 5 } },
  { name: "frequency_penalty", probeBody: { frequency_penalty: 0.5 } },
  { name: "presence_penalty", probeBody: { presence_penalty: 0.5 } },
];

// Probe queue for async processing
const probeQueue = [];
const queuedModels = new Set(); // Track models already queued or running (for dedup)
let probeRunning = false;

/**
 * Queue an async probe task for a model
 * @param {object} options - { connectionId, model, credentials, proxyOptions }
 */
export async function queueProbeTask(options) {
  // Skip if missing required fields
  if (!options?.connectionId || !options?.model || !options?.credentials) {
    console.log(`[ParamProbe] Skipping probe task: missing required fields`);
    return;
  }
  
  const { connectionId, model } = options;
  const queueKey = `${connectionId}:${model}`;
  
  // Dedup: skip if already queued
  if (queuedModels.has(queueKey)) {
    console.log(`[ParamProbe] Skipping probe for ${model}: already queued`);
    return;
  }
  
  // Check cooldown: skip if recently probed
  const { shouldProbe } = await import("../../src/lib/paramSupportCache.js");
  if (!await shouldProbe(connectionId, model)) {
    console.log(`[ParamProbe] Skipping probe for ${model}: recently probed (cooldown)`);
    return;
  }
  
  queuedModels.add(queueKey);
  probeQueue.push({
    ...options,
    queuedAt: Date.now(),
    queueKey
  });
  
  // Start processing if not already running
  if (!probeRunning) {
    processProbeQueue();
  }
}

/**
 * Process probe queue asynchronously
 */
async function processProbeQueue() {
  probeRunning = true;
  
  while (probeQueue.length > 0) {
    const task = probeQueue.shift();

    try {
      await probeModelParams(task);
    } catch (err) {
      console.log(`[ParamProbe] Probe failed for ${task.model}: ${err.message}`);
    } finally {
      queuedModels.delete(task.queueKey);
    }
    
    // Small delay between probes to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }
  
  probeRunning = false;
}

/**
 * Probe all parameters for a specific model
 * @param {object} options - { connectionId, model, credentials, proxyOptions }
 * @returns {object} - { param: boolean } results
 */
export async function probeModelParams(options) {
  const { connectionId, model, credentials, proxyOptions } = options;
  
  // Extract baseUrl and apiKey from credentials
  const baseUrl = credentials?.providerSpecificData?.baseUrl;
  const apiKey = credentials?.apiKey || credentials?.accessToken;
  
  // Skip if no baseUrl (can't send probe requests)
  if (!baseUrl) {
    console.log(`[ParamProbe] Skipping probe for ${model}: no baseUrl in credentials`);
    return null;
  }
  
  // Pre-detect which token parameter this model supports
  // Some models reject max_tokens and require max_completion_tokens
  let supportedTokenParam = "max_tokens"; // default
  let maxTokensSupport = null;
  const tokenTestBody = { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false };
  try {
    const tokenTestResponse = await sendProbeRequest(baseUrl, apiKey, tokenTestBody, proxyOptions);
    if (!tokenTestResponse.ok && tokenTestResponse.status === 400) {
      const errorText = await tokenTestResponse.text();
      if (errorText.toLowerCase().includes("max_tokens") &&
          (errorText.toLowerCase().includes("unsupported") || errorText.toLowerCase().includes("not supported"))) {
        maxTokensSupport = false;
        // max_tokens not supported, try max_completion_tokens
        const altTestBody = { model, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 1, stream: false };
        const altTestResponse = await sendProbeRequest(baseUrl, apiKey, altTestBody, proxyOptions);
        const altErrorText = altTestResponse.status === 400 ? await altTestResponse.text() : "";
        if (altTestResponse.ok || altTestResponse.status !== 400 ||
            !altErrorText.toLowerCase().includes("max_completion_tokens")) {
          supportedTokenParam = "max_completion_tokens";
          console.log(`[ParamProbe] ${model}: uses max_completion_tokens instead of max_tokens`);
        }
        if (altTestResponse.status !== 400) await cancelResponseBody(altTestResponse);
      }
    } else if (tokenTestResponse.ok) {
      maxTokensSupport = true;
      await cancelResponseBody(tokenTestResponse);
    } else {
      await cancelResponseBody(tokenTestResponse);
    }
  } catch (err) {
    console.log(`[ParamProbe] Token pre-detect failed: ${err.message}, using max_tokens`);
  }
  
  const results = {};
  const baseBody = {
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: false
  };
  if (maxTokensSupport !== null) {
    results.max_tokens = maxTokensSupport;
  }

  for (const paramConfig of PROBE_PARAMS) {
    // Skip streaming-only params for non-streaming probe context
    // (streaming params will be detected when actual streaming request fails)
    if (paramConfig.streamingOnly) {
      results[paramConfig.name] = null;
      continue;
    }

    // Build probe body, handling conflicting params
    let probeBody = { ...baseBody, ...paramConfig.probeBody };    
    // max_completion_tokens and max_tokens shouldn't coexist
    if (paramConfig.name === "max_completion_tokens") {
      probeBody.max_completion_tokens = probeBody.max_tokens || 1;
      delete probeBody.max_tokens;
    } else {
      // Use the pre-detected supported token param
      if (!probeBody.max_tokens && !probeBody.max_completion_tokens) {
        probeBody[supportedTokenParam] = 1;
      }
    }
    
    try {
      const response = await sendProbeRequest(baseUrl, apiKey, probeBody, proxyOptions);
      
      if (response.ok) {
        results[paramConfig.name] = true;
        await cancelResponseBody(response);
      } else if (response.status === 400) {
        const errorBody = await response.text();
        // Check if the error is specifically about this parameter
        const isParamError = isParamUnsupported(errorBody, paramConfig.name);
        results[paramConfig.name] = !isParamError;
      } else {
        // Other errors (401, 403, 429, 5xx) - upstream issue, abort entire probe
        console.log(`[ParamProbe] Aborting probe for ${model}: non-400 error ${response.status}`);
        // Mark remaining params as unknown
        for (const remaining of PROBE_PARAMS) {
          if (results[remaining.name] === undefined) {
            results[remaining.name] = null;
          }
        }
        await cancelResponseBody(response);
        break; // Exit loop
      }
    } catch (err) {
      // Network error - can't determine
      console.log(`[ParamProbe] Probe ${paramConfig.name} failed: ${err.message}`);
      results[paramConfig.name] = null;
    }
  }

  // Import cache module dynamically to update results
  const { batchSetParamSupport } = await import("../../src/lib/paramSupportCache.js");
  await batchSetParamSupport(connectionId, model, results);

  console.log(`[ParamProbe] Results for ${model}: ${JSON.stringify(results)}`);
  
  return results;
}

/**
 * Send a probe request
 */
async function sendProbeRequest(baseUrl, apiKey, body, proxyOptions) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey && { "Authorization": `Bearer ${apiKey}` })
  };

  return proxyAwareFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  }, proxyOptions || null);
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Ignore cleanup failures; probes use status/error text only.
  }
}

/**
 * Check if error body indicates a specific parameter is unsupported
 */
function isParamUnsupported(errorBody, paramName) {
  const lower = errorBody.toLowerCase();
  const paramLower = paramName.toLowerCase();
  
  // Check for parameter name in error
  if (!lower.includes(paramLower) &&
      !lower.includes(paramLower.replace("_", "")) &&
      !lower.includes(paramLower.replace(".", "_"))) {
    return false;
  }
  
  // Check for VALUE errors first (parameter IS supported, value is wrong)
  const valueErrorKeywords = ["invalid value", "out of range", "must be between", "must be", "value should", "minimum", "maximum", "too small", "too large"];
  if (valueErrorKeywords.some(e => lower.includes(e))) {
    // This is a value problem, parameter IS supported
    return false;
  }
  
  // Check for "unsupported parameter" keywords
  return lower.includes("unknown") ||
         lower.includes("unsupported") ||
         lower.includes("not supported") ||
         lower.includes("unexpected") ||
         lower.includes("unrecognized");
}

/**
 * Get current queue length (for monitoring)
 */
export function getProbeQueueLength() {
  return probeQueue.length;
}

/**
 * Clear queue (for testing)
 */
export function clearProbeQueue() {
  probeQueue.length = 0;
  queuedModels.clear();
}
