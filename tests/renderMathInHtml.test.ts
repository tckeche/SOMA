/**
 * AI feedback is stored as HTML and bypasses the MarkdownRenderer, so any
 * LaTeX inside it previously reached students as raw source. renderMathInHtml
 * pre-renders those spans with KaTeX before sanitization.
 */
import { describe, expect, it } from "vitest";
import { renderMathInHtml } from "../client/src/lib/renderMathInHtml";

describe("renderMathInHtml", () => {
  it("renders inline $...$ math to KaTeX markup", () => {
    const out = renderMathInHtml("<p>The fraction $\\frac{1}{2}$ matters.</p>");
    expect(out).toContain("katex");
    expect(out).not.toContain("$\\frac{1}{2}$");
  });

  it("renders \\(...\\) and \\[...\\] delimiters", () => {
    const out = renderMathInHtml("<p>Try \\(x^2\\) and \\[\\frac{a}{b}\\]</p>");
    expect(out).toContain("katex");
    expect(out).not.toContain("\\(x^2\\)");
  });

  it("renders $$...$$ display math", () => {
    const out = renderMathInHtml("<p>$$x^2 + 1$$</p>");
    expect(out).toContain("katex-display");
  });

  it("leaves currency amounts untouched", () => {
    const html = "<p>You saved $50 and then $60 more.</p>";
    expect(renderMathInHtml(html)).toBe(html);
  });

  it("leaves plain HTML untouched", () => {
    const html = "<p>No math here.</p>";
    expect(renderMathInHtml(html)).toBe(html);
  });

  it("never throws on malformed LaTeX", () => {
    expect(() => renderMathInHtml("<p>$\\frac{1}{$</p>")).not.toThrow();
  });
});
