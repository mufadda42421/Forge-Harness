import { eq } from "drizzle-orm";
import { schema, type ForgeDatabase } from "@forge/database";
import { ForgeError, nowMs } from "@forge/shared";
import type { ChatMessage, TokenUsage } from "@forge/shared";
import type { ModelRouter } from "../router/router.js";
import { assembleContext } from "../context/engine.js";
import { executeTool } from "../tools/manager.js";

export interface AgentRunInput {
  agentId: string;
  input: string;
  /** Optional prior messages for multi-turn runs. */
  history?: ChatMessage[];
  projectId?: string | null;
  workflowExecutionId?: string | null;
  /** Called when a tool requires approval; return true to approve. */
  approveTool?: (toolName: string, args: unknown) => Promise<boolean> | boolean;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  executionId: string;
  output: string;
  toolCalls: number;
  usage: TokenUsage;
  latencyMs: number;
  toolMessages: Array<{ tool: string; status: string }>;
}

/** Execute a single agent. Tool loop is bounded by agents.executionLimit. */
export async function runAgent(
  db: ForgeDatabase,
  router: ModelRouter,
  params: AgentRunInput,
): Promise<AgentRunResult> {
  const started = nowMs();
  const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, params.agentId)).limit(1);
  const agent = agentRows[0];
  if (!agent) throw ForgeError.notFound("Agent");
  if (!agent.enabled) throw new ForgeError("EXECUTION_ERROR", `Agent "${agent.name}" is disabled`, 409);
  if (agent.isExample) {
    // Example agents may run, but only if the user assigned a model to them.
    if (!agent.modelId) throw new ForgeError("MODEL_NOT_AVAILABLE", `Example agent "${agent.name}" has no model assigned. Assign a registered model first.`, 422);
  }
  if (!agent.modelId) {
    throw new ForgeError("MODEL_NOT_AVAILABLE", `Agent "${agent.name}" has no model assigned. Assign a registered model first.`, 422);
  }

  const execution = db.insert(schema.agentExecutions).values({
    agentId: agent.id,
    workflowExecutionId: params.workflowExecutionId ?? null,
    status: "running",
    input: params.input,
    startedAt: started,
  }).returning({ id: schema.agentExecutions.id }).all()[0];
  const executionId = execution!.id;

  try {
    // Context assembly (user-provided only, lexical relevance)
    let systemPrompt = agent.systemInstructions.trim();
    if (agent.contextMode !== "none") {
      const assembled = await assembleContext(db, { projectId: params.projectId ?? null, agentId: agent.id }, params.input);
      if (assembled.text) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${assembled.text}` : assembled.text;
      }
    }

    // Tool allowlist: ONLY tools explicitly granted to this agent
    const grants = await db.select().from(schema.agentTools).where(eq(schema.agentTools.agentId, agent.id));
    const allowedToolIds = new Set(grants.map((g) => g.toolIntegrationId));
    const toolRows = (await db.select().from(schema.toolIntegrations)).filter(
      (t) => allowedToolIds.has(t.id) && t.enabled,
    );
    const toolSpecs = toolRows.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: safeJson(t.inputSchemaJson, { type: "object", properties: {} }),
    }));

    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const h of params.history ?? []) messages.push(h);
    messages.push({ role: "user", content: params.input });

    const insertMessage = (role: string, content: string, meta: Record<string, unknown> = {}) => {
      db.insert(schema.agentMessages).values({
        workflowExecutionId: params.workflowExecutionId ?? null,
        agentExecutionId: executionId,
        role,
        agentName: agent.name,
        content: content.slice(0, 100_000),
        metaJson: JSON.stringify(meta),
      }).run();
    };
    insertMessage("system", systemPrompt || "(no system instructions)");
    insertMessage("user", params.input);

    const maxIterations = Math.max(1, agent.executionLimit);
    let promptTokens = 0, completionTokens = 0, totalTokens = 0, costSum = 0, costAny = false, toolCalls = 0;
    let finalOutput = "";
    const toolMessages: Array<{ tool: string; status: string }> = [];

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const result = await router.chat({
        modelRowId: agent.modelId,
        messages,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        responseFormat: agent.outputFormat === "json" ? "json" : "text",
        agentExecutionId: executionId,
        workflowExecutionId: params.workflowExecutionId ?? undefined,
        agentId: agent.id,
        signal: params.signal,
      });
      promptTokens += result.usage.promptTokens ?? 0;
      completionTokens += result.usage.completionTokens ?? 0;
      totalTokens += result.usage.totalTokens ?? 0;
      if (result.estimatedCostUsd !== null) { costSum += result.estimatedCostUsd; costAny = true; }

      if (result.toolCalls.length === 0) {
        finalOutput = result.content;
        insertMessage("assistant", result.content, { finishReason: result.finishReason });
        break;
      }

      toolCalls += result.toolCalls.length;
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      insertMessage("assistant", result.content, { toolCalls: result.toolCalls.map((t) => t.function.name) });

      for (const call of result.toolCalls) {
        const tool = toolRows.find((t) => t.name === call.function.name);
        let parsedArgs: unknown = {};
        try { parsedArgs = JSON.parse(call.function.arguments || "{}"); } catch { parsedArgs = {}; }
        if (!tool) {
          const denied = `Tool "${call.function.name}" is not granted to this agent`;
          toolMessages.push({ tool: call.function.name, status: "denied" });
          messages.push({ role: "tool", content: denied, toolCallId: call.id, name: call.function.name });
          insertMessage("tool", denied, { tool: call.function.name, status: "denied" });
          continue;
        }
        let approved = false;
        if (params.approveTool) {
          approved = Boolean(await params.approveTool(tool.name, parsedArgs));
        }
        const toolResult = await executeTool(db, tool.id, parsedArgs, {
          approved,
          agentExecutionId: executionId,
        });
        const status = toolResult.status;
        toolMessages.push({ tool: tool.name, status });
        const toolPayload =
          status === "success"
            ? JSON.stringify(toolResult.output)
            : status === "awaiting_approval"
              ? "Tool requires user approval before execution."
              : `Tool ${status}: ${toolResult.error ?? "unknown"}`;
        messages.push({ role: "tool", content: toolPayload, toolCallId: call.id, name: tool.name });
        insertMessage("tool", toolPayload, { tool: tool.name, status });
      }

      if (iteration === maxIterations - 1) {
        const note = "Execution limit reached before a final answer was produced.";
        insertMessage("system", note, { executionLimit: maxIterations });
        finalOutput = result.content || note;
      }
    }

    const finished = nowMs();
    db.update(schema.agentExecutions)
      .set({
        status: "success",
        output: finalOutput,
        toolCalls,
        promptTokens: promptTokens || null,
        completionTokens: completionTokens || null,
        totalTokens: totalTokens || null,
        estimatedCostUsd: costAny ? costSum : null,
        latencyMs: finished - started,
        finishedAt: finished,
      })
      .where(eq(schema.agentExecutions.id, executionId))
      .run();

    return {
      executionId,
      output: finalOutput,
      toolCalls,
      usage: {
        promptTokens: promptTokens || null,
        completionTokens: completionTokens || null,
        totalTokens: totalTokens || null,
      },
      latencyMs: finished - started,
      toolMessages,
    };
  } catch (err) {
    const finished = nowMs();
    const message = err instanceof Error ? err.message : String(err);
    db.update(schema.agentExecutions)
      .set({ status: "failed", error: message.slice(0, 1000), finishedAt: finished, latencyMs: finished - started })
      .where(eq(schema.agentExecutions.id, executionId))
      .run();
    throw err;
  }
}

function safeJson(text: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return fallback;
  } catch {
    return fallback;
  }
}
