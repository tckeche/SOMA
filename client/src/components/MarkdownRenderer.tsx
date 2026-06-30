import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// A brace group with one level of nesting: {…} possibly containing {…}.
const BRACE_GROUP = String.raw`\{(?:[^{}]|\{[^{}]*\})*\}`;
// A contiguous bare-LaTeX run: starts at a \command (with optional [..] and {..}
// arguments) or a base^{exp} / base_{sub} token, and extends through directly
// attached math characters — e.g. "\frac{1}{2}xe^{x^2}+C" or "\sqrt{x^2+1}".
const BARE_LATEX_RUN = new RegExp(
  String.raw`(?:\\[a-zA-Z]+(?:\[[^\]]*\])?(?:${BRACE_GROUP})*|[A-Za-z0-9)\]][\^_](?:${BRACE_GROUP}|[A-Za-z0-9]))` +
  String.raw`(?:[A-Za-z0-9^_+\-*/=(),.]|${BRACE_GROUP}|\\[a-zA-Z]+)*`,
  "g",
);

// True when stripped of LaTeX commands the text still contains prose-length
// words — i.e. it's a sentence with math in it, not a pure expression.
function looksLikeProse(text: string): boolean {
  return /[a-zA-Z]{4,}/.test(text.replace(/\\[a-zA-Z]+/g, " "));
}

// Wrap bare (undelimited) LaTeX inside a segment that contains no $ math.
function wrapBareLatexInSegment(segment: string): string {
  const hasBareLatexCmd = /\\[a-zA-Z]/.test(segment);
  const hasBraceExponent = /[a-zA-Z0-9]\^{|[a-zA-Z0-9]_{/.test(segment);
  if (!hasBareLatexCmd && !hasBraceExponent) return segment;
  // Pure expression (e.g. an MCQ option like "xe^{x^2}+C") → wrap whole thing.
  if (!looksLikeProse(segment)) {
    const lead = segment.match(/^\s*/)?.[0] ?? "";
    const trail = segment.match(/\s*$/)?.[0] ?? "";
    const core = segment.trim();
    return core ? `${lead}$${core}$${trail}` : segment;
  }
  // Sentence with embedded math → wrap each contiguous LaTeX run so the
  // fraction renders without italicising the surrounding prose.
  return segment.replace(BARE_LATEX_RUN, (run) => {
    if (!/\\[a-zA-Z]|[\^_]/.test(run)) return run;
    // Keep sentence punctuation outside the math span.
    const m = run.match(/^([\s\S]*?)([.,;:]*)$/);
    const core = (m?.[1] ?? run).trim();
    const punct = m?.[2] ?? "";
    return core ? `$${core}$${punct}` : run;
  });
}

export function normalizeLatexDelimiters(text: string): string {
  let result = text;

  // Step 0: Escape currency dollar signs BEFORE any other processing.
  // A "$" followed by an amount is treated as currency when it cannot be a
  // valid math span: either no closing "$" exists, or the next "$" itself
  // starts another amount (e.g. "between $5 and $7"). Genuine math like
  // "$1+2$" or "$5 \times 3$" keeps its delimiters.
  // In markdown, \$ is a backslash-escaped dollar sign rendering a literal "$".
  // 0a: thousands-separator amounts are always currency ($9,000 / $100,000.50).
  result = result.replace(/\$(?=\d{1,3}(?:,\d{3})+)/g, "\\$");
  // 0b: plain amounts ($50, $9.99) are currency when no closing "$" follows,
  // or when the next "$" itself starts another amount ("between $5 and $7").
  result = result.replace(/\$(\d+(?:\.\d+)?)/g, (match, amount, offset: number, str: string) => {
    if (offset > 0 && (str[offset - 1] === "\\" || str[offset - 1] === "$")) return match;
    const rest = str.slice(offset + match.length);
    if (rest.startsWith("$")) return match; // "$50$$" edge — leave to later steps
    const nextDollar = rest.indexOf("$");
    if (nextDollar === -1) return `\\$${amount}`; // no closing $ → currency
    if (/\d/.test(rest[nextDollar + 1] ?? "")) return `\\$${amount}`; // next $ is another amount
    return match; // a plausible closing delimiter exists → leave as math
  });

  // Step 1: \[...\] → $$...$$
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$${math}$$`);

  // Step 2: \(...\) → $...$
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math}$`);

  // Step 3: Fix malformed matrix row separators " \ " -> " \\ " inside matrix-like envs.
  result = result.replace(
    /(\\begin\{(?:array|tabular|aligned|cases|matrix|pmatrix|bmatrix|vmatrix)\})([\s\S]*?)(\\end\{(?:array|tabular|aligned|cases|matrix|pmatrix|bmatrix|vmatrix)\})/g,
    (_match, open, body, close) => {
      const fixedBody = body.replace(/\s\\\s/g, " \\\\ ");
      return `${open}${fixedBody}${close}`;
    },
  );

  // Step 4: bare \begin{env}...\end{env} environments → $$...$$
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

  // Step 5: If AI puts display math $$...$$ inline in a sentence, treat it as inline math.
  // remark-math often expects $$ blocks on their own line.
  result = result.replace(/\$\$([^\n$]+?)\$\$/g, (_, math) => `$${math}$`);

  // Step 6: Wrap common command-led expressions that appear right before a math block.
  // Example: "\\mathbf{a}= $$...$$" -> "$\\mathbf{a}=$ $...$"
  result = result.replace(/(\\[a-zA-Z]+\{[^}]+\}\s*=\s*)(?=\$|\\\[|\\\()/g, (_, expr) => `$${expr}$`);

  // Step 7: bare LaTeX — AI-generated math often has NO delimiters at all.
  // e.g. \frac{1}{2}xe^{x^2}+C   or   xe^{x^2}+C   or   \sqrt{x^2+1}
  // This must also work for MIXED content ("Simplify \frac{1}{2} given $x$"):
  // split on existing math spans and only wrap bare LaTeX in the text between
  // them, otherwise fractions sitting next to delimited math render as raw text.
  if (/\\[a-zA-Z]|[a-zA-Z0-9]\^{|[a-zA-Z0-9]_{/.test(result)) {
    result = result
      .split(/((?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$[^$\n]*?(?<!\\)\$)/)
      .map((segment, i) => (i % 2 === 1 ? segment : wrapBareLatexInSegment(segment)))
      .join("");
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
            <div className="my-3 rounded-xl overflow-hidden border border-border/50">
              {language && (
                <div className="bg-foreground/5 px-4 py-1.5 text-xs text-muted-foreground font-mono border-b border-border/30">
                  {language}
                </div>
              )}
              <pre className="bg-foreground/10 p-4 overflow-x-auto">
                <code className={`text-sm font-mono text-foreground ${codeClassName}`}>
                  {codeChildren}
                </code>
              </pre>
            </div>
          );
        },
        code({ className: codeClassName, children, ...props }) {
          return (
            <code
              className="bg-foreground/10 text-primary px-1.5 py-0.5 rounded text-[0.85em] font-mono border border-border/30 break-words"
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
              <table className="w-full border-collapse border border-border/50 text-sm">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return <th className="bg-foreground/5 border border-border/50 px-3 py-2 text-left font-semibold">{children}</th>;
        },
        td({ children }) {
          return <td className="border border-border/50 px-3 py-2">{children}</td>;
        },
        blockquote({ children }) {
          return <blockquote className="border-l-2 border-primary/50 pl-4 my-2 text-muted-foreground italic">{children}</blockquote>;
        },
        strong({ children }) {
          return <strong className="font-semibold text-foreground">{children}</strong>;
        },
      }}
    >
      {normalized}
    </ReactMarkdown>
    </div>
  );
}

export default React.memo(MarkdownRenderer, (prev, next) => prev.content === next.content && prev.className === next.className);
