import { describe, expect, it } from "vitest";
import { normalizeLatexDelimiters } from "../client/src/components/MarkdownRenderer";

describe("normalizeLatexDelimiters", () => {
  it("normalizes malformed inline matrix and command-led expression", () => {
    const input = String.raw`Given the vectors \mathbf{a}= $$\begin{pmatrix}3 \ 4\end{pmatrix}$$ and \mathbf{b}= $$\begin{pmatrix}1 \ 2\end{pmatrix}$$`;
    const normalized = normalizeLatexDelimiters(input);

    expect(normalized).toContain(String.raw`$\mathbf{a}= $`);
    expect(normalized).toContain(String.raw`$\begin{pmatrix}3 \\ 4\end{pmatrix}$`);
    expect(normalized).toContain(String.raw`$\mathbf{b}= $`);
    expect(normalized).toContain(String.raw`$\begin{pmatrix}1 \\ 2\end{pmatrix}$`);
  });

  it("escapes currency without breaking math", () => {
    const input = "A laptop costs $9,000 and solve $x+1=2$.";
    const normalized = normalizeLatexDelimiters(input);

    expect(normalized).toContain("\\$9,000");
    expect(normalized).toContain("$x+1=2$");
  });

  it("escapes plain currency with no thousands separator ($50 each)", () => {
    expect(normalizeLatexDelimiters("Each ticket costs $50 for adults.")).toContain("\\$50");
    expect(normalizeLatexDelimiters("The book is $9.99 today.")).toContain("\\$9.99");
  });

  it("escapes paired currency amounts ($5 and $7) instead of treating the span as math", () => {
    const normalized = normalizeLatexDelimiters("Prices range between $5 and $7 per item.");
    expect(normalized).toContain("\\$5");
    expect(normalized).toContain("\\$7");
  });

  it("keeps genuine math that starts with a digit ($5 \\times 3$)", () => {
    expect(normalizeLatexDelimiters(String.raw`Compute $5 \times 3$ first.`)).toContain(String.raw`$5 \times 3$`);
    expect(normalizeLatexDelimiters("The value $50$ is even.")).toContain("$50$");
  });

  it("wraps a fully-bare LaTeX option in math delimiters", () => {
    expect(normalizeLatexDelimiters(String.raw`\frac{1}{2}xe^{x^2}+C`)).toBe(String.raw`$\frac{1}{2}xe^{x^2}+C$`);
    expect(normalizeLatexDelimiters("xe^{x^2}+C")).toBe("$xe^{x^2}+C$");
  });

  it("wraps bare LaTeX runs inside prose without italicising the sentence", () => {
    const normalized = normalizeLatexDelimiters(String.raw`The answer is \frac{1}{2} because halving works.`);
    expect(normalized).toContain(String.raw`$\frac{1}{2}$`);
    expect(normalized).toContain("The answer is ");
    expect(normalized).toContain(" because halving works.");
  });

  it("wraps bare LaTeX even when other delimited math exists (mixed-content regression)", () => {
    // The old all-or-nothing check skipped wrapping whenever ANY "$" existed,
    // leaving \frac to render as raw text.
    const normalized = normalizeLatexDelimiters(String.raw`Simplify \frac{3}{6} given $x = 2$.`);
    expect(normalized).toContain(String.raw`$\frac{3}{6}$`);
    expect(normalized).toContain("$x = 2$");
  });

  it("does not double-wrap LaTeX already inside delimiters", () => {
    const input = String.raw`Solve $\frac{1}{2}x = 4$ now.`;
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });
});
