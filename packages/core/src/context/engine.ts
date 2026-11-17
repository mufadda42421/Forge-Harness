import { and, eq, inArray, desc } from "drizzle-orm";
import { schema, type ForgeDatabase } from "@forge/database";

export interface ContextScope {
  projectId?: string | null;
  agentId?: string | null;
}

export interface AssembledContext {
  /** Rendered markdown block to prepend to the system prompt. */
  text: string | null;
  documentIds: string[];
  memoryCount: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "be", "this", "that",
  "it", "as", "by", "at", "from", "your", "you", "i", "we", "they", "do", "not", "use", "using", "can",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Simple lexical relevance score: count of unique query-term hits in the document. */
export function lexicalScore(query: string, document: string): number {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return 0;
  const haystack = ` ${document.toLowerCase()} `;
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score / terms.length; // 0..1 coverage
}

/**
 * Assemble context for an agent run. Embedding retrieval is intentionally not
 * required: documents are scored lexically. Only documents the user explicitly
 * created are ever included — nothing is fetched from external services.
 */
export async function assembleContext(
  db: ForgeDatabase,
  scope: ContextScope,
  query: string,
  budgetChars = 6_000,
): Promise<AssembledContext> {
  const docs = await db.select().from(schema.contextDocuments).orderBy(desc(schema.contextDocuments.updatedAt));
  const memories = await db.select().from(schema.memoryEntries).orderBy(desc(schema.memoryEntries.createdAt));

  const inScope = <T extends { scope: string; projectId: string | null; agentId: string | null }>(row: T): boolean => {
    if (row.scope === "global") return true;
    if (row.scope === "project") return scope.projectId != null && row.projectId === scope.projectId;
    if (row.scope === "agent") return scope.agentId != null && row.agentId === scope.agentId;
    return false;
  };

  const scored = docs
    .filter(inScope)
    .map((doc) => ({ doc, score: lexicalScore(query, `${doc.title}\n${doc.content}`) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  const usedIds: string[] = [];
  let used = 0;
  for (const { doc } of scored) {
    const block = `### ${doc.title}\n${doc.content}\n`;
    if (used + block.length > budgetChars) break;
    parts.push(block);
    used += block.length;
    usedIds.push(doc.id);
  }

  const memoryLines: string[] = [];
  let memoryUsed = 0;
  for (const mem of memories.filter(inScope)) {
    const line = `- ${mem.content}`;
    if (used + memoryUsed + line.length > budgetChars) break;
    memoryLines.push(line);
    memoryUsed += line.length;
  }
  if (memoryLines.length > 0) {
    parts.push(`### Memory\n${memoryLines.join("\n")}`);
  }

  if (parts.length === 0) {
    return { text: null, documentIds: [], memoryCount: 0 };
  }
  return {
    text: `## Context (user-provided)\n${parts.join("\n")}`,
    documentIds: usedIds,
    memoryCount: memoryLines.length,
  };
}
