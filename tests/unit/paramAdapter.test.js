import { describe, it, expect, beforeEach } from "vitest";

import { adaptParams } from "../../src/lib/paramAdapter.js";
import { clearMemoryCache, detectUnsupportedParam, setParamSupport } from "../../src/lib/paramSupportCache.js";

describe("param adapter", () => {
  beforeEach(() => {
    clearMemoryCache();
  });

  it("detects max_tokens unsupported errors", () => {
    const errorBody = JSON.stringify({
      error: {
        message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      },
    });

    expect(detectUnsupportedParam(errorBody)).toBe("max_tokens");
  });

  it("adapts max_tokens to max_completion_tokens when max_tokens is unsupported", async () => {
    await setParamSupport("conn-1", "o3-test", "max_tokens", false);

    const adapted = await adaptParams("conn-1", "o3-test", {
      model: "o3-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 12,
    });

    expect(adapted).toMatchObject({ max_completion_tokens: 12 });
    expect(adapted.max_tokens).toBeUndefined();
  });

  it("keeps the existing max_completion_tokens fallback for providers that reject it", async () => {
    await setParamSupport("conn-1", "legacy-test", "max_completion_tokens", false);

    const adapted = await adaptParams("conn-1", "legacy-test", {
      model: "legacy-test",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 8,
    });

    expect(adapted).toMatchObject({ max_tokens: 8 });
    expect(adapted.max_completion_tokens).toBeUndefined();
  });
});
