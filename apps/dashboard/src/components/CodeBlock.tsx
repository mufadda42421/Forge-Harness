import { useEffect, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c++", cpp);
hljs.registerLanguage("c", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("plaintext", plaintext);

export interface CodeBlockProps {
  /** Raw code/text to render. */
  code: string;
  /** Language id (hljs). When omitted, an auto-detect over the common subset is used. */
  language?: string;
  /** Small label shown in the header bar (defaults to the detected/provided language). */
  title?: string;
  maxHeight?: number | string;
  className?: string;
}

const DETECT_SUBSET = ["typescript", "javascript", "python", "bash", "json", "sql", "yaml", "go", "rust", "java", "cpp", "css", "xml", "markdown"];

function highlight(code: string, language?: string): { html: string; lang: string } {
  if (language && hljs.getLanguage(language)) {
    return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, lang: language };
  }
  if (language) {
    return { html: escapeHtml(code), lang: language };
  }
  // Auto-detect restricted to the common subset to avoid false positives.
  const result = hljs.highlightAuto(code, DETECT_SUBSET);
  return { html: result.value, lang: result.language ?? "text" };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Code block with header bar (language badge + one-click copy) and
 * highlight.js syntax coloring. Used for agent outputs, code generation,
 * tool results and raw payloads.
 */
export function CodeBlock({ code, language, title, maxHeight = 340, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const { html, lang } = highlight(code, language);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // clipboard unavailable (permissions) — select the text instead
      const el = codeRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  return (
    <div className={`code-block${className ? ` ${className}` : ""}`} style={{ padding: 0, overflow: "hidden" }}>
      <div className="code-header">
        <div className="row" style={{ gap: 8 }}>
          <span className="code-lang">{title ?? lang}</span>
          <span className="code-meta">{code.split("\n").length} line{code.split("\n").length === 1 ? "" : "s"} · {code.length} chars</span>
        </div>
        <button className="code-copy" onClick={copy} aria-label="Copy code">
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <pre className="code-body" style={{ maxHeight }}>
        <code ref={codeRef} className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
