import { eq } from "drizzle-orm";
import { schema, type ForgeDatabase } from "@forge/database";
import { nowMs } from "@forge/shared";
import type { ModelRouter } from "../router/router.js";

export interface BenchmarkRunParams {
  suiteId: string;
  modelRowIds: string[];
  repeatCount?: number;
  signal?: AbortSignal;
}

export interface BenchmarkSummary {
  runId: string;
  suiteId: string;
  status: "success" | "failed";
  totalResults: number;
  passed: number;
  failed: number;
  inconclusive: number;
}

/**
 * Execute a benchmark suite against user-selected registered models.
 * Deterministic checks only: optional substring / regex match defined by the
 * user per case. No quality judgement is invented.
 */
export async function runBenchmark(
  db: ForgeDatabase,
  router: ModelRouter,
  params: BenchmarkRunParams,
): Promise<BenchmarkSummary> {
  const started = nowMs();
  const cases = await db.select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.suiteId, params.suiteId));
  const run = db.insert(schema.benchmarkRuns).values({
    suiteId: params.suiteId,
    modelRowIdsJson: JSON.stringify(params.modelRowIds),
    status: "running",
    repeatCount: Math.max(1, Math.min(params.repeatCount ?? 1, 10)),
    startedAt: started,
  }).returning({ id: schema.benchmarkRuns.id }).all()[0];
  const runId = run!.id;

  let passed = 0, failed = 0, inconclusive = 0;
  try {
    for (const modelRowId of params.modelRowIds) {
      for (const testCase of cases) {
        for (let iteration = 1; iteration <= (params.repeatCount ?? 1); iteration += 1) {
          if (params.signal?.aborted) throw new Error("cancelled");
          let output: string | null = null;
          let error: string | null = null;
          let usage = { promptTokens: null as number | null, completionTokens: null as number | null, totalTokens: null as number | null };
          let latencyMs: number | null = null;
          let estimatedCostUsd: number | null = null;
          try {
            const result = await router.chat({
              modelRowId,
              messages: [{ role: "user", content: testCase.prompt }],
              signal: params.signal,
            });
            output = result.content;
            latencyMs = result.latencyMs;
            usage = result.usage;
            estimatedCostUsd = result.estimatedCostUsd;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
          const passedCheck = error
            ? false
            : checkCase(testCase, output ?? "");
          if (passedCheck === null) inconclusive += 1;
          else if (passedCheck) passed += 1;
          else failed += 1;
          db.insert(schema.benchmarkResults).values({
            runId,
            caseId: testCase.id,
            iteration,
            modelRowId,
            output: output?.slice(0, 100_000) ?? null,
            passed: passedCheck,
            latencyMs,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            estimatedCostUsd,
            error,
          }).run();
        }
      }
    }
    db.update(schema.benchmarkRuns).set({ status: "success", finishedAt: nowMs() }).where(eq(schema.benchmarkRuns.id, runId)).run();
    return { runId, suiteId: params.suiteId, status: "success", totalResults: passed + failed + inconclusive, passed, failed, inconclusive };
  } catch (err) {
    db.update(schema.benchmarkRuns).set({ status: "failed", finishedAt: nowMs() }).where(eq(schema.benchmarkRuns.id, runId)).run();
    throw err;
  }
}

function checkCase(
  testCase: { expectedSubstring: string | null; expectedRegex: string | null },
  output: string,
): boolean | null {
  if (testCase.expectedSubstring) return output.includes(testCase.expectedSubstring);
  if (testCase.expectedRegex) {
    try {
      return new RegExp(testCase.expectedRegex, "s").test(output);
    } catch {
      return null;
    }
  }
  return null; // no deterministic check configured — result is informational
}
