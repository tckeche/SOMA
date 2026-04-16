import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function normalizeLatexDelimiters(text: string): string {
  let result = text;

  // Step 0: Escape currency dollar signs BEFORE any other processing.
  // Target patterns that are unambiguously currency (comma-separated thousands like
  // $9,000 or 4+ consecutive digits like $1500) to avoid breaking legitimate LaTeX
  // where $ is followed by a single digit (e.g. $5x + 3$).
  result = result.replace(/\$(?=\d{1,3},\d{3}|\d{4,})/g, "\\$");

  // Step 1: \[...\] → $$...$$
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$${math}$$`);

  // Step 2: \(...\) → $...$
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math}$`);

  // Step 3: bare \begin{env}...\end{env} environments → $$...$$
  result = result.replace(
    /(\\begin\{(?:array|tabular|aligned|cases|matrix|pmatrix|bmatrix|vmatrix)\}[\s\S]*?\\end\{(?:array|tabular|aligned|cases|matrix|pmatrix|bmatrix|vmatrix)\})/g,
    (match, _group, offset, string) => {
      const before = string.slice(0, offset);
      const after = string.slice(offset + match.length);
      const alreadyDelimited =
        (before.endsWith("$$") && after.startsWith("$$")) ||
        (before.endsWith("\\[") && after.startsWith("\\]"));
      return alreadyDelimited ? match : `$$${match}$$`;
    },
  );

  // Step 4: bare LaTeX — AI-generated math options often have NO delimiters at all.
  // e.g. \frac{1}{2}xe^{x^2}+C   or   xe^{x^2}+C   or   \sqrt{x^2+1}
  // Detect any LaTeX command (\word) or brace-exponent notation (x^{, x_{})
  // that is NOT already inside a $ or \[ delimiter, then wrap the whole string.
  const hasAnyDelimiter = /\$|\\\[|\\\(/.test(result);
  if (!hasAnyDelimiter) {
    const hasBareLatexCmd = /\\[a-zA-Z]/.test(result);
    const hasBraceExponent = /[a-zA-Z0-9]\^{|[a-zA-Z0-9]_{/.test(result);
    if (hasBareLatexCmd || hasBraceExponent) {
      result = `$${result}$`;
    }
  }

  return result;
}

function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  if (!content) return null;

  const normalized = normalizeLatexDelimiters(content);

  return (
    <div className={`markdown-content ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        pre({ children, ...props }) {
          const codeElement = children as any;
          const codeClassName = codeElement?.props?.className || "";
          const codeChildren = codeElement?.props?.children;
          const language = codeClassName ? codeClassName.replace("language-", "") : "";
          return (
            <div className="my-3 rounded-xl overflow-hidden border border-white/10">
              {language && (
                <div className="bg-white/5 px-4 py-1.5 text-xs text-slate-500 font-mono border-b border-white/5">
                  {language}
                </div>
              )}
              <pre className="bg-[rgba(0,0,0,0.4)] p-4 overflow-x-auto">
                <code className={`text-sm font-mono text-slate-200 ${codeClassName}`}>
                  {codeChildren}
                </code>
              </pre>
            </div>
          );
        },
        code({ className: codeClassName, children, ...props }) {
          return (
            <code
              className="bg-white/10 text-violet-300 px-1.5 py-0.5 rounded text-[0.85em] font-mono border border-white/5"
              {...props}
            >
              {children}
            </code>
          );
        },
        p({ children }) {
          return <p className="mb-2 last:mb-0">{children}</p>;
        },
        ul({ children }) {
          return <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>;
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-3">
              <table className="w-full border-collapse border border-white/10 text-sm">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return <th className="bg-white/5 border border-white/10 px-3 py-2 text-left font-semibold">{children}</th>;
        },
        td({ children }) {
          return <td className="border border-white/10 px-3 py-2">{children}</td>;
        },
        blockquote({ children }) {
          return <blockquote className="border-l-2 border-violet-500/50 pl-4 my-2 text-slate-400 italic">{children}</blockquote>;
        },
        strong({ children }) {
          return <strong className="font-semibold text-slate-100">{children}</strong>;
        },
      }}
    >
      {normalized}
    </ReactMarkdown>
    </div>
  );
}

export default React.memo(MarkdownRenderer, (prev, next) => prev.content === next.content && prev.className === next.className);
