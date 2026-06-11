import katex from "katex";

/**
 * Render LaTeX delimiters embedded in an AI-generated HTML string to KaTeX
 * markup. The feedback pipeline stores feedback as HTML, which bypasses the
 * MarkdownRenderer — any `$…$`, `\(…\)` or `\[…\]` inside it would otherwise
 * reach the student as raw LaTeX source.
 *
 * Call BEFORE DOMPurify.sanitize so the KaTeX output is sanitized too.
 */
export function renderMathInHtml(html: string): string {
  if (!html || !/[$\\]/.test(html)) return html;
  const render = (math: string, displayMode: boolean): string => {
    try {
      return katex.renderToString(math.trim(), { displayMode, throwOnError: false, strict: false });
    } catch {
      return math; // never let a malformed expression take down the feedback panel
    }
  };
  return html
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => render(m, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => render(m, false))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => render(m, true))
    // Inline $…$: opening $ must not precede whitespace, closing $ must not
    // follow whitespace or precede a digit — this keeps currency like
    // "$50 and $60" out of math mode.
    .replace(/\$(?!\s)([^$\n]+?)(?<![\s\\])\$(?!\d)/g, (_, m) => render(m, false));
}
