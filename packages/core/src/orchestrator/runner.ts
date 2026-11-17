import { eq } from "drizzle-orm";
import { schema, type ForgeDatabase } from "@forge/database";
import { ForgeError, nowMs } from "@forge/shared";
import type { ModelRouter } from "../router/router.js";
import { runAgent } from "../agents/runner.js";

export type OrchestrationPattern = "sequential" | "parallel" | "hierarchical" | "evaluator" | "debate";

export interface OrchestratorStep {
  agentId: string;
  /** Optional per-step task; defaults to the shared input. */
  task?: string;
  role?: string;
}

export interface RunOrchestrationInput {
  pattern: OrchestrationPattern;
  input: string;
  steps: OrchestratorStep[];
  /** Evaluator/debate judge agent. Required for 'evaluator' and 'debate'. */
  judgeAgentId?: string;
  /** Hierarchical: supervisor agent that synthesizes specialist outputs. Defaults to first step. */
  supervisorAgentId?: string;
  /** Bounded evaluator iterations (default 2, hard cap 5). */
  maxIterations?: number;
  projectId?: string | null;
  signal?: AbortSignal;
  approveTool?: (toolName: string, args: unknown) => Promise<boolean> | boolean;
  triggeredBy?: string;
}

export interface OrchestrationStepResult {
  agentId: string;
  agentName: string;
  output: string;
  status: "success" | "failed";
  error?: string;
  tokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
}

export interface OrchestrationResult {
  executionId: string;
  pattern: OrchestrationPattern;
  status: "success" | "failed";
  output: string;
  steps: OrchestrationStepResult[];
  totalTokens: number;
  estimatedCostUsd: number | null;
}

const HARD_ITERATION_CAP = 5;

/**
 * Multi-agent orchestration. Every pattern is bounded:
 *  - no recursive agent spawning; steps are fixed up front
 *  - evaluator loop is capped (default 2, max 5)
 *  - cancellation propagates via AbortSignal
 */
export async function runOrchestration(
  db: ForgeDatabase,
  router: ModelRouter,
  params: RunOrchestrationInput,
): Promise<OrchestrationResult> {
  const started = nowMs();
  if (!params.steps.length) throw ForgeError.validation("At least one agent step is required");
  if ((params.pattern === "evaluator" || params.pattern === "debate") && !params.judgeAgentId) {
    throw ForgeError.validation(`Pattern "${params.pattern}" requires judgeAgentId`);
  }
  const maxIterations = Math.min(Math.max(1, params.maxIterations ?? 2), HARD_ITERATION_CAP);

  const execution = db.insert(schema.workflowExecutions).values({
    workflowId: null,
    workflowVersionId: null,
    status: "running",
    inputJson: JSON.stringify({ input: params.input, pattern: params.pattern }),
    triggeredBy: params.triggeredBy ?? "orchestrator",
    startedAt: started,
  }).returning({ id: schema.workflowExecutions.id }).all()[0];
  const executionId = execution!.id;

  const agentName = async (agentId: string) =>
    (await db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1))[0]?.name ?? agentId;

  const stepResults: OrchestrationStepResult[] = [];
  const runStep = async (step: OrchestratorStep, input: string): Promise<OrchestrationStepResult> => {
    const name = await agentName(step.agentId);
    try {
      const result = await runAgent(db, router, {
        agentId: step.agentId,
        input,
        projectId: params.projectId ?? null,
        workflowExecutionId: executionId,
        approveTool: params.approveTool,
        signal: params.signal,
      });
      return {
        agentId: step.agentId,
        agentName: name,
        output: result.output,
        status: "success",
        tokens: result.usage.totalTokens,
        estimatedCostUsd: null,
        latencyMs: result.latencyMs,
      };
    } catch (err) {
      return {
        agentId: step.agentId,
        agentName: name,
        output: "",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        tokens: null,
        estimatedCostUsd: null,
        latencyMs: 0,
      };
    }
  };

  const recordOrchestratorMessage = (content: string, meta: Record<string, unknown> = {}) => {
    db.insert(schema.agentMessages).values({
      workflowExecutionId: executionId,
      role: "message",
      agentName: "orchestrator",
      content: content.slice(0, 100_000),
      metaJson: JSON.stringify(meta),
    }).run();
  };

  let output = "";
  let status: "success" | "failed" = "success";

  try {
    switch (params.pattern) {
      case "sequential": {
        let current = params.input;
        for (const step of params.steps) {
          const result = await runStep(step, step.task ?? current);
          stepResults.push(result);
          if (result.status === "failed") { status = "failed"; break; }
          current = result.output;
        }
        output = current;
        break;
      }
      case "parallel": {
        const results = await Promise.all(
          params.steps.map((step) => runStep(step, step.task ?? params.input)),
        );
        stepResults.push(...results);
        if (results.every((r) => r.status === "failed")) status = "failed";
        output = results.map((r) => `## ${r.agentName}\n${r.status === "success" ? r.output : `[failed] ${r.error}`}`).join("\n\n");
        break;
      }
      case "hierarchical": {
        const supervisorId = params.supervisorAgentId ?? params.steps[0]!.agentId;
        const specialists = params.steps.filter((s) => s.agentId !== supervisorId);
        const specialistResults = await Promise.all(
          (specialists.length ? specialists : params.steps).map((step) => runStep(step, step.task ?? params.input)),
        );
        stepResults.push(...specialistResults);
        const synthesisInput = [
          `Original task:\n${params.input}`,
          "",
          "Specialist reports:",
          ...specialistResults.map((r) => `### ${r.agentName} (${r.status})\n${r.output || r.error || ""}`),
          "",
          "Synthesize the specialist reports into one final answer. Note disagreements explicitly.",
        ].join("\n");
        const synthesis = await runStep({ agentId: supervisorId }, synthesisInput);
        stepResults.push(synthesis);
        if (synthesis.status === "failed") status = "failed";
        output = synthesis.output;
        break;
      }
      case "evaluator": {
        const producer = params.steps[0]!;
        let current = params.input;
        let producerOutput = "";
        for (let i = 0; i < maxIterations; i += 1) {
          const produced = await runStep(producer, current);
          stepResults.push(produced);
          if (produced.status === "failed") { status = "failed"; break; }
          producerOutput = produced.output;
          const verdict = await runStep(
            { agentId: params.judgeAgentId! },
            [
              "You are an independent evaluator. Judge the following output against the task.",
              "Respond with exactly one of: APPROVED or REVISION_NEEDED, followed by 1-3 bullet points of concrete fixes.",
              "",
              `Task:\n${params.input}`,
              "",
              `Output:\n${producerOutput}`,
            ].join("\n"),
          );
          stepResults.push(verdict);
          if (/^APPROVED\b/i.test(verdict.output.trim()) || i === maxIterations - 1) {
            current = producerOutput;
            break;
          }
          current = `${params.input}\n\nYour previous attempt was rejected by the evaluator. Feedback:\n${verdict.output}\n\nProduce an improved version.`;
          recordOrchestratorMessage(`revision requested (iteration ${i + 1})`, { iteration: i + 1 });
        }
        output = producerOutput;
        if (status !== "failed" && stepResults.some((s) => s.status === "failed")) status = "failed";
        break;
      }
      case "debate": {
        const debaterResults = await Promise.all(
          params.steps.map((step, idx) =>
            runStep({ agentId: step.agentId, role: step.role }, step.task ?? `${params.input}\n\nYou are debater ${idx + 1}. Argue your position rigorously and explicitly.`),
          ),
        );
        stepResults.push(...debaterResults);
        const verdict = await runStep(
          { agentId: params.judgeAgentId! },
          [
            "You are an impartial judge. Compare these debated positions and pick the strongest, with reasons.",
            "",
            `Task:\n${params.input}`,
            "",
            ...debaterResults.map((r, i) => `### Debater ${i + 1} — ${r.agentName}\n${r.output || r.error || ""}`),
          ].join("\n"),
        );
        stepResults.push(verdict);
        if (verdict.status === "failed") status = "failed";
        output = verdict.output;
        break;
      }
    }
  } catch (err) {
    status = "failed";
    output = "";
    recordOrchestratorMessage(`orchestrator error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const finished = nowMs();
  const totalTokens = stepResults.reduce((acc, s) => acc + (s.tokens ?? 0), 0);
  db.update(schema.workflowExecutions)
    .set({
      status,
      outputJson: JSON.stringify({ output }),
      error: status === "failed" ? stepResults.find((s) => s.error)?.error ?? "orchestration failed" : null,
      finishedAt: finished,
    })
    .where(eq(schema.workflowExecutions.id, executionId))
    .run();
  recordOrchestratorMessage(`orchestration ${status}`, { pattern: params.pattern });

  return {
    executionId,
    pattern: params.pattern,
    status,
    output,
    steps: stepResults,
    totalTokens,
    estimatedCostUsd: null,
  };
}
