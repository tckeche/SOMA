import { describe, expect, it } from "vitest";
import { renderGraphSvgWithPython } from "../server/services/pythonGraphRenderer";

describe("renderGraphSvgWithPython", () => {
  it("returns svg for a valid line graph spec", async () => {
    const svg = await renderGraphSvgWithPython({
      plotType: "line",
      equation: "2*x + 1",
      xRange: [0, 5],
      yRange: [0, 12],
      axisLabels: { x: "x", y: "y" },
      showGrid: true,
      tickInterval: 1,
    });

    expect(svg).toBeTruthy();
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
  });
});
