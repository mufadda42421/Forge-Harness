import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "./types.js";

describe("estimateCostUsd", () => {
  it("returns null when pricing is unknown (never invents cost)", () => {
    expect(estimateCostUsd({ promptTokens: 100, completionTokens: 100, totalTokens: 200 }, { inputCostPer1M: null, outputCostPer1M: 0.5 })).toBeNull();
    expect(estimateCostUsd({ promptTokens: 100, completionTokens: 100, totalTokens: 200 }, { inputCostPer1M: 1, outputCostPer1M: null })).toBeNull();
  });

  it("returns null when usage is unknown", () => {
    expect(estimateCostUsd({ promptTokens: null, completionTokens: 10, totalTokens: null }, { inputCostPer1M: 1, outputCostPer1M: 1 })).toBeNull();
  });

  it("computes cost from configured pricing", () => {
    const cost = estimateCostUsd({ promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 }, { inputCostPer1M: 2, outputCostPer1M: 8 });
    expect(cost).toBeCloseTo(2 + 4, 6);
  });
});
