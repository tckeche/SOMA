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
});
