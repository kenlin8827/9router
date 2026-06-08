/**
 * Parameter Support Cache
 * 
 * Stores per-provider, per-model parameter compatibility results.
 * Currently uses in-memory cache only (no DB persistence).
 * 
 * TODO: Add DB persistence for param support data
 * - Store in providerSpecificData.paramSupport.models[modelId]
 * - Need to evaluate DB schema compatibility impact
 * - See discussion in PR review about JSON field safety
 */

// In-memory cache: Map<connectionId:modelId:param, { value, timestamp }>
const memoryCache = new Map();

// Memory cache - no TTL (param support is stable, only clears on restart)
// If you want TTL, set it to a long duration like 24 hours
const MEMORY_CACHE_TTL_MS = 0; // 0 = no expiry

// Probe cooldown period - don't probe again within this time (10 minutes)
const PROBE_COOLDOWN_MS = 10 * 60 * 1000;

// Track when models were probed (for cooldown)
const probeTimestamps = new Map(); // Map<connectionId:modelId, timestamp>

/**
 * Check if we should probe this model (hasn't been probed recently)
 */
export async function shouldProbe(connectionId, modelId) {
  const key = `${connectionId}:${modelId}`;
  const lastProbed = probeTimestamps.get(key);
  if (!lastProbed) return true;
  
  const elapsed = Date.now() - lastProbed;
  return elapsed > PROBE_COOLDOWN_MS;
}

/**
 * Get parameter support status for a specific model
 * @returns {boolean|null} - true=supported, false=not supported, null=unknown
 */
export async function getParamSupport(connectionId, modelId, param) {
  const cacheKey = `${connectionId}:${modelId}:${param}`;
  const cached = memoryCache.get(cacheKey);
  
  if (cached !== undefined) {
    // Check TTL only if set (0 = no expiry)
    if (MEMORY_CACHE_TTL_MS > 0 && Date.now() - cached.timestamp > MEMORY_CACHE_TTL_MS) {
      memoryCache.delete(cacheKey);
      return null;
    }
    return cached.value;
  }
  
  return null;
}

/**
 * Get all parameter support info for a model
 * @returns {object|null} - { param: boolean } or null if not cached
 */
export async function getAllParamSupport(connectionId, modelId) {
  const results = {};
  const prefix = `${connectionId}:${modelId}:`;
  
  for (const [key, entry] of memoryCache.entries()) {
    if (key.startsWith(prefix)) {
      // Check TTL only if set (0 = no expiry)
      if (MEMORY_CACHE_TTL_MS > 0 && Date.now() - entry.timestamp > MEMORY_CACHE_TTL_MS) {
        continue;
      }
      const param = key.slice(prefix.length);
      if (!param.startsWith("_")) {
        results[param] = entry.value;
      }
    }
  }
  
  return Object.keys(results).length > 0 ? results : null;
}

/**
 * Mark a parameter as supported/unsupported for a specific model
 */
export async function setParamSupport(connectionId, modelId, param, supported) {
  const cacheKey = `${connectionId}:${modelId}:${param}`;
  memoryCache.set(cacheKey, { value: supported, timestamp: Date.now() });
  
  // TODO: Add DB persistence
  // await updateProviderConnection(connectionId, {
  //   providerSpecificData: {
  //     ...current,
  //     paramSupport: {
  //       models: {
  //         ...models,
  //         [modelId]: {
  //           ...models[modelId],
  //           [param]: supported,
  //           _updatedAt: new Date().toISOString()
  //         }
  //       }
  //     }
  //   }
  // });
}

/**
 * Batch set parameter support for a model (called after full probe)
 */
export async function batchSetParamSupport(connectionId, modelId, params) {
  const now = Date.now();
  
  for (const [param, supported] of Object.entries(params)) {
    if (param.startsWith("_")) continue; // Skip metadata
    if (supported === null) continue; // Skip unknown results
    const cacheKey = `${connectionId}:${modelId}:${param}`;
    memoryCache.set(cacheKey, { value: supported, timestamp: now });
  }
  
  // Mark as probed for cooldown
  const probeKey = `${connectionId}:${modelId}`;
  probeTimestamps.set(probeKey, now);
  
  // TODO: Add DB persistence
  // await updateProviderConnection(connectionId, {
  //   providerSpecificData: {
  //     ...current,
  //     paramSupport: {
  //       models: {
  //         ...models,
  //         [modelId]: {
  //           ...models[modelId],
  //           ...params,
  //           _probedAt: new Date().toISOString()
  //         }
  //       }
  //     }
  //   }
  // });
}

/**
 * Clear memory cache (for testing)
 */
export function clearMemoryCache() {
  memoryCache.clear();
  probeTimestamps.clear();
}

/**
 * Parse error response to detect which parameter caused the error
 * @returns {string|null} - Parameter name that caused the error, or null
 */
export function detectUnsupportedParam(errorBody) {
  const lower = errorBody.toLowerCase();
  
  const patterns = [
    { param: "max_tokens", keywords: ["max_tokens"] },
    { param: "max_completion_tokens", keywords: ["max_completion_tokens", "max_completion_token", "max_completion"] },
    { param: "reasoning_effort", keywords: ["reasoning_effort", "reasoningeffort"] },
    { param: "thinking", keywords: ["thinking", "budget_tokens"] },
    { param: "response_format.json_schema", keywords: ["json_schema", "structured output"] },
    { param: "stream_options", keywords: ["stream_options", "include_usage"] },
    { param: "temperature", keywords: ["temperature"] },
    { param: "logprobs", keywords: ["logprobs", "top_logprobs"] },
    { param: "frequency_penalty", keywords: ["frequency_penalty"] },
    { param: "presence_penalty", keywords: ["presence_penalty"] },
  ];

  // Error keywords that indicate parameter is NOT SUPPORTED (not just invalid value)
  // "invalid" alone can mean "invalid value" (range/type issue), not "parameter unsupported"
  const unsupportedKeywords = ["unknown", "unsupported", "not supported", "unexpected", "unrecognized", "does not support", "unsupported parameter", "invalid_parameter_error", "invalid parameter"];
  
  // Keywords that indicate VALUE is invalid (parameter IS supported, value is wrong)
  const valueErrorKeywords = ["invalid value", "out of range", "must be between", "must be", "value should", "range", "minimum", "maximum"];

  for (const { param, keywords } of patterns) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        // First check if it's a VALUE error (parameter IS supported)
        if (valueErrorKeywords.some(e => lower.includes(e))) {
          // This is a value problem, not unsupported parameter
          return null;
        }
        // Check if it's an error indicating parameter is NOT SUPPORTED
        if (unsupportedKeywords.some(e => lower.includes(e))) {
          return param;
        }
      }
    }
  }

  return null;
}
