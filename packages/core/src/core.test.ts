import { describe, it, expect } from "vitest";
import { validateWorkflowDefinition, type WorkflowDefinition } from "./workflow/validate.js";
import { lexicalScore, tokenize } from "./context/engine.js";
import { decideToolPolicy } from "./tools/manager.js";
import { OpenAICompatibleAdapter } from "./providers/openai-compatible.js";
import type { ProviderConfig } from "./providers/types.js";
import { createAdapter } from "./providers/factory.js";

const agentNode = (key: string, agentId = "a1") => ({
  key,
  type: "agent" as const,
  label: key,
  config: { agentId },
});

describe("validateWorkflowDefinition", () => {
  it("accepts a valid sequential workflow", () => {
    const def: WorkflowDefinition = {
      nodes: [agentNode("a"), agentNode("b")],
      edges: [{ source: "a", target: "b" }],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects cycles", () => {
    const def: WorkflowDefinition = {
      nodes: [agentNode("a"), agentNode("b"), agentNode("c")],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "c", target: "a" },
      ],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Cycle"))).toBe(true);
  });

  it("rejects edges to unknown nodes", () => {
    const def: WorkflowDefinition = {
      nodes: [agentNode("a")],
      edges: [{ source: "a", target: "ghost" }],
    };
    expect(validateWorkflowDefinition(def).valid).toBe(false);
  });

  it("rejects duplicate node keys", () => {
    const def: WorkflowDefinition = {
      nodes: [agentNode("a"), agentNode("a")],
      edges: [],
    };
    expect(validateWorkflowDefinition(def).valid).toBe(false);
  });

  it("requires condition edges to declare true/false", () => {
    const def: WorkflowDefinition = {
      nodes: [{ key: "c", type: "condition", label: "c", config: { field: "input", operator: "truthy" } }, agentNode("a")],
      edges: [{ source: "c", target: "a" }],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(false);
  });

  it("requires agent nodes to have agentId", () => {
    const def: WorkflowDefinition = {
      nodes: [{ key: "a", type: "agent", label: "a", config: {} }],
      edges: [],
    };
    expect(validateWorkflowDefinition(def).valid).toBe(false);
  });
});

describe("lexicalScore", () => {
  it("ranks documents containing query terms higher than those that do not", () => {
    const query = "database migration strategy";
    const hit = lexicalScore(query, "Our database strategy uses incremental migrations.");
    const miss = lexicalScore(query, "The weather report for tomorrow is sunny.");
    expect(hit).toBeGreaterThan(0);
    expect(hit).toBeGreaterThan(miss);
  });

  it("tokenizes and drops stopwords", () => {
    expect(tokenize("The quick brown fox")).toContain("quick");
    expect(tokenize("The quick brown fox")).not.toContain("the");
  });
});

describe("decideToolPolicy", () => {
  it("denies disabled tools outright", () => {
    expect(decideToolPolicy({ permission: "read-only", requiresApproval: false, enabled: false })).toBe("deny");
  });
  it("always requires approval for dangerous tools", () => {
    expect(decideToolPolicy({ permission: "dangerous", requiresApproval: false, enabled: true }, { autoApproveReadOnly: true, autoApproveAll: false })).toBe("require_approval");
  });
  it("auto-approves read-only tools when policy allows", () => {
    expect(decideToolPolicy({ permission: "read-only", requiresApproval: false, enabled: true }, { autoApproveReadOnly: true, autoApproveAll: false })).toBe("allow");
  });
  it("autoApproveAll overrides everything except disabled", () => {
    expect(decideToolPolicy({ permission: "dangerous", requiresApproval: true, enabled: true }, { autoApproveReadOnly: false, autoApproveAll: true })).toBe("allow");
  });
});

describe("OpenAICompatibleAdapter", () => {
  const config: ProviderConfig = {
    id: "p1",
    name: "Test",
    baseUrl: "https://example.test/v1",
    compatibility: "openai",
    authMethod: "bearer",
    apiKey: "sk-test-key-00001234",
    customHeaders: {},
    timeoutMs: 5000,
    maxRetries: 0,
  };

  it("sends chat completion and normalizes usage", async () => {
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({
        model: "test-model",
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const adapter = new OpenAICompatibleAdapter(config);
      const result = await adapter.chatCompletion({ model: "test-model", messages: [{ role: "user", content: "hi" }] });
      expect(result.content).toBe("hello");
      expect(result.usage.totalTokens).toBe(15);
      expect(bodies[0]).toContain("test-model");
      expect(bodies[0]).not.toContain("sk-test-key-00001234");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes 401 to PROVIDER_AUTH", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    try {
      const adapter = new OpenAICompatibleAdapter(config);
      await expect(adapter.chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createAdapter", () => {
  const base = {
    id: "p", name: "p", baseUrl: "https://example.test", compatibility: "openai" as const,
    authMethod: "bearer" as const, apiKey: "k", customHeaders: {}, timeoutMs: 1000, maxRetries: 0,
  };
  it("builds adapters for each compatibility type", () => {
    for (const compat of ["openai", "openrouter", "custom-http", "anthropic", "google", "ollama"] as const) {
      expect(() => createAdapter({ ...base, compatibility: compat })).not.toThrow();
    }
  });
  it("never returns a preconfigured provider: requires explicit config only", () => {
    expect(() => createAdapter({ ...base, compatibility: "nope" as never })).toThrow();
  });
});
