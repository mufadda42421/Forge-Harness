import { CodeBlock } from "./CodeBlock";

export interface ModelOutputProps {
  /** Raw model/agent text, possibly containing ```fenced code blocks. */
  content: string;
  maxHeight?: number | string;
}

/**
 * Renders model output as prose + syntax-highlighted code segments.
 * Text outside ``` fences renders as plain paragraphs; fenced segments
 * render through <CodeBlock> (language tag honoured, e.g. ```ts).
 */
export function ModelOutput({ content, maxHeight = 400 }: ModelOutputProps) {
  const segments = splitFences(content);
  return (
    <div className="model-output">
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlock key={i} code={seg.code} language={seg.lang} maxHeight={maxHeight} className="model-output-code" />
        ) : (
          seg.text.trim() ? <div key={i} className="model-output-text">{seg.text.trim()}</div> : null
        ),
      )}
    </div>
  );
}

export type Segment = { type: "code"; lang?: string; code: string } | { type: "text"; text: string };

/**
 * Split raw text into prose and fenced-code segments. Unterminated fences
 * degrade gracefully to a code segment at end-of-input.
 */
export function splitFences(input: string): Segment[] {
  const segments: Segment[] = [];
  const lines = input.split("\n");
  let buffer: string[] = [];
  let inCode = false;
  let lang: string | undefined;

  const flush = () => {
    if (buffer.length === 0) return;
    if (inCode) segments.push({ type: "code", lang, code: buffer.join("\n") });
    else segments.push({ type: "text", text: buffer.join("\n") });
    buffer = [];
  };

  for (const line of lines) {
    const m = /^```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line.trimEnd());
    if (m) {
      flush();
      if (inCode) {
        inCode = false;
        lang = undefined;
      } else {
        inCode = true;
        lang = m[1] || undefined;
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return segments;
}
