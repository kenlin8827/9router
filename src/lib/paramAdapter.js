/**
 * Parameter Adapter
 *
 * Wraps executor.execute with parameter adaptation, error detection, and retry.
 * Minimal changes to existing code - just replace executor.execute with wrapExecute.
 */

import { setParamSupport, detectUnsupportedParam, getAllParamSupport } from "./paramSupportCache.js";

/**
 * Wrap executor.execute with param adaptation and retry logic
 *
 * Usage: Replace `executor.execute(...)` with `wrapExecute(executor, ...)`
 *
 * @returns {object} - { response, url, headers, transformedBody, paramErrorHandled? }
 */
export async function wrapExecute(executor, { model, body, stream, credentials, signal, log, proxyOptions, connectionId }) {
  // Step 1: Adapt params based on cached support info
  let adaptedBody = body;
  if (connectionId) {
    adaptedBody = await adaptParams(connectionId, model, body);
  }

  // Helper: execute with post-transform adaptation
  const executeWithAdaptation = async (requestBody) => executor.execute({
    model,
    body: requestBody,
    stream,
    credentials,
    signal,
    log,
    proxyOptions,
    adaptTransformedBody: connectionId
      ? transformed => adaptParams(connectionId, model, transformed)
      : null
  });

  // Step 2: Execute request
  const result = await executeWithAdaptation(adaptedBody);
  
  const MAX_RETRIES = 3;
  let currentResult = result;
  let retryCount = 0;
  const detectedParams = new Set(); // Track params detected in this loop
  
  // Loop to handle multiple unsupported params (one per 400 response)
  while (!currentResult.response.ok && currentResult.response.status === 400 && connectionId && retryCount < MAX_RETRIES) {
    // Clone response to read error text without consuming original body
    const clonedResponse = currentResult.response.clone();
    const errorText = await clonedResponse.text();
    const unsupportedParam = detectUnsupportedParam(errorText);
    
    if (!unsupportedParam) {
      // Not a param-related error, stop retrying
      break;
    }
    
    // Check if we've already detected this param (body unchanged, stop retrying)
    if (detectedParams.has(unsupportedParam)) {
      log?.warn?.("PARAMPROBE", `${model}: ${unsupportedParam} detected again, body unchanged, stopping retry`);
      break;
    }
    detectedParams.add(unsupportedParam);
    
    log?.info?.("PARAMPROBE", `${model}: detected unsupported param ${unsupportedParam} (retry ${retryCount + 1}/${MAX_RETRIES})`);
    
    await cancelResponseBody(currentResult.response);

    // Mark param as unsupported
    await setParamSupport(connectionId, model, unsupportedParam, false);
    
    // Re-adapt params with updated cache (applied to original body)
    const retryBody = await adaptParams(connectionId, model, body);
    
    // Retry with post-transform adaptation
    currentResult = await executeWithAdaptation(retryBody);
    retryCount++;
  }
  
  // Queue async probe for other params (after all retries, success or fail)
  if (retryCount > 0 && connectionId) {
    const { queueProbeTask } = await import("../../open-sse/services/paramProbe.js");
    queueProbeTask({ connectionId, model, credentials, proxyOptions });
  }
  
  if (currentResult.response.ok && retryCount > 0) {
    log?.info?.("PARAMPROBE", `${model}: retry succeeded after ${retryCount} attempts`);
    return { ...currentResult, paramErrorHandled: true, retriesUsed: retryCount };  
  }
  
  if (retryCount > 0) {
    log?.warn?.("PARAMPROBE", `${model}: retry failed after ${retryCount} attempts`);
    return { ...currentResult, paramErrorHandled: false, retriesUsed: retryCount };
  }
  
  return result;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Ignore cleanup failures; retry handling should continue.
  }
}

/**
 * Adapt request body parameters based on cached support info
 * Optimized: fetch all param support at once, then apply adaptations
 *
 * @param {string} connectionId - Provider connection ID
 * @param {string} modelId - Model ID
 * @param {object} body - Request body to adapt
 * @returns {object} - Adapted request body
 */
export async function adaptParams(connectionId, modelId, body) {
  if (!connectionId || !modelId || !body) return body;

  // Fetch all cached param support at once (more efficient than 7 separate DB reads)
  const cached = await getAllParamSupport(connectionId, modelId);
  if (!cached) return body; // No cache data, can't adapt

  const adapted = { ...body };

  // max_tokens -> max_completion_tokens
  if (adapted.max_tokens !== undefined && cached.max_tokens === false) {
    console.log(`[ParamAdapter] ${modelId}: max_tokens -> max_completion_tokens`);
    adapted.max_completion_tokens = adapted.max_tokens;
    delete adapted.max_tokens;
  }

  // max_completion_tokens → max_tokens
  if (adapted.max_completion_tokens !== undefined && cached.max_completion_tokens === false) {
    console.log(`[ParamAdapter] ${modelId}: max_completion_tokens -> max_tokens`);
    adapted.max_tokens = adapted.max_completion_tokens;
    delete adapted.max_completion_tokens;
  }

  // max_completion_token -> max_tokens (tolerate singular client/upstream variants)
  if (adapted.max_completion_token !== undefined && cached.max_completion_tokens === false) {
    console.log(`[ParamAdapter] ${modelId}: max_completion_token -> max_tokens`);
    adapted.max_tokens = adapted.max_completion_token;
    delete adapted.max_completion_token;
  }

  // reasoning_effort → delete
  if (adapted.reasoning_effort !== undefined && cached.reasoning_effort === false) {
    console.log(`[ParamAdapter] ${modelId}: removing reasoning_effort`);
    delete adapted.reasoning_effort;
  }

  // thinking → delete
  if (adapted.thinking !== undefined && cached.thinking === false) {
    console.log(`[ParamAdapter] ${modelId}: removing thinking`);
    delete adapted.thinking;
  }

  // stream_options → delete
  if (adapted.stream_options !== undefined && cached.stream_options === false) {
    console.log(`[ParamAdapter] ${modelId}: removing stream_options`);
    delete adapted.stream_options;
  }

  // temperature → delete
  if (adapted.temperature !== undefined && cached.temperature === false) {
    console.log(`[ParamAdapter] ${modelId}: removing temperature`);
    delete adapted.temperature;
  }

  // response_format.json_schema → json_object
  if (adapted.response_format?.type === "json_schema" && cached["response_format.json_schema"] === false) {
    console.log(`[ParamAdapter] ${modelId}: json_schema → json_object`);
    adapted.response_format = { type: "json_object" };
  }

  // logprobs/top_logprobs → delete
  if ((adapted.logprobs !== undefined || adapted.top_logprobs !== undefined) && cached.logprobs === false) {
    console.log(`[ParamAdapter] ${modelId}: removing logprobs/top_logprobs`);
    delete adapted.logprobs;
    delete adapted.top_logprobs;
  }

  // frequency_penalty → delete
  if (adapted.frequency_penalty !== undefined && cached.frequency_penalty === false) {
    console.log(`[ParamAdapter] ${modelId}: removing frequency_penalty`);
    delete adapted.frequency_penalty;
  }

  // presence_penalty → delete
  if (adapted.presence_penalty !== undefined && cached.presence_penalty === false) {
    console.log(`[ParamAdapter] ${modelId}: removing presence_penalty`);
    delete adapted.presence_penalty;
  }

  return adapted;
}
