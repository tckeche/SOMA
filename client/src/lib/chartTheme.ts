import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export type ChartPalette = {
  axisTick: string;
  axisTickMuted: string;
  gridStroke: string;
  axisLine: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipFg: string;
  tooltipMuted: string;
  tooltipShadow: string;
  cursorFill: string;
  thresholdStroke: string;
  series: string[];
  radarArea: string;
  radarStroke: string;
};

const DARK: ChartPalette = {
  axisTick: "#cbd5e1",
  axisTickMuted: "#64748b",
  gridStroke: "rgba(148,163,184,0.14)",
  axisLine: "rgba(148,163,184,0.20)",
  tooltipBg: "rgba(15,23,42,0.95)",
  tooltipBorder: "rgba(148,163,184,0.20)",
  tooltipFg: "#f1f5f9",
  tooltipMuted: "#94a3b8",
  tooltipShadow: "0 8px 32px rgba(0,0,0,0.5)",
  cursorFill: "rgba(139,92,246,0.10)",
  thresholdStroke: "#f87171",
  series: [
    "#A78BFA", "#FBBF24", "#34D399", "#60A5FA",
    "#F472B6", "#22D3EE", "#FB923C", "#818CF8",
  ],
  radarArea: "rgba(139,92,246,0.28)",
  radarStroke: "#A78BFA",
};

const LIGHT: ChartPalette = {
  axisTick: "#1e293b",
  axisTickMuted: "#475569",
  gridStroke: "rgba(71,85,105,0.22)",
  axisLine: "rgba(71,85,105,0.30)",
  tooltipBg: "rgba(255,255,255,0.98)",
  tooltipBorder: "rgba(71,85,105,0.25)",
  tooltipFg: "#0f172a",
  tooltipMuted: "#475569",
  tooltipShadow: "0 8px 32px rgba(15,23,42,0.18)",
  cursorFill: "rgba(99,102,241,0.10)",
  thresholdStroke: "#b91c1c",
  series: [
    "#6D28D9", "#B45309", "#047857", "#1D4ED8",
    "#BE185D", "#0E7490", "#C2410C", "#3730A3",
  ],
  radarArea: "rgba(109,40,217,0.22)",
  radarStroke: "#6D28D9",
};

export function useChartPalette(): ChartPalette {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return DARK;
  return resolvedTheme === "light" ? LIGHT : DARK;
}
