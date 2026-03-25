import type { GraphQuestionSpec } from "@shared/schema";

type SubjectPreset = "mathematics" | "physics" | "economics" | "business" | "chemistry" | "biology";

type PresetPatch = Partial<Pick<GraphQuestionSpec, "axisLabels" | "xRange" | "yRange" | "showGrid" | "tickInterval" | "asymptotes">>;

const PRESET_BY_KIND: Record<string, PresetPatch> = {
  "economics:supply_demand": {
    axisLabels: { x: "Quantity", y: "Price" },
    xRange: [0, 10],
    yRange: [0, 10],
    showGrid: true,
    tickInterval: 1,
  },
  "business:break_even": {
    axisLabels: { x: "Output", y: "Cost / Revenue" },
    xRange: [0, 20],
    yRange: [0, 20],
    showGrid: true,
    tickInterval: 2,
  },
  "chemistry:titration_curve": {
    axisLabels: { x: "Volume added (cm³)", y: "pH" },
    xRange: [0, 50],
    yRange: [0, 14],
    showGrid: true,
    tickInterval: 1,
  },
  "biology:enzyme_activity": {
    axisLabels: { x: "Temperature (°C)", y: "Rate of reaction" },
    xRange: [0, 100],
    yRange: [0, 10],
    showGrid: true,
    tickInterval: 10,
  },
  "physics:velocity_time": {
    axisLabels: { x: "Time (s)", y: "Velocity (m/s)" },
    showGrid: true,
    tickInterval: 1,
  },
};

const SUBJECT_DEFAULTS: Record<SubjectPreset, PresetPatch> = {
  mathematics: { axisLabels: { x: "x", y: "y" }, showGrid: true, tickInterval: 1 },
  physics: { showGrid: true, tickInterval: 1 },
  economics: { showGrid: true, tickInterval: 1 },
  business: { showGrid: true, tickInterval: 1 },
  chemistry: { showGrid: true, tickInterval: 1 },
  biology: { showGrid: true, tickInterval: 1 },
};

export function applyGraphPreset(spec: GraphQuestionSpec): GraphQuestionSpec {
  const subject = (spec.subjectPreset || "mathematics") as SubjectPreset;
  const kindKey = spec.graphKind ? `${subject}:${spec.graphKind}` : "";
  const subjectPatch = SUBJECT_DEFAULTS[subject] ?? SUBJECT_DEFAULTS.mathematics;
  const kindPatch = PRESET_BY_KIND[kindKey] ?? {};

  return {
    ...subjectPatch,
    ...kindPatch,
    ...spec,
    axisLabels: {
      ...(subjectPatch.axisLabels ?? {}),
      ...(kindPatch.axisLabels ?? {}),
      ...(spec.axisLabels ?? {}),
    },
    asymptotes: {
      vertical: [...(subjectPatch.asymptotes?.vertical ?? []), ...(kindPatch.asymptotes?.vertical ?? []), ...(spec.asymptotes?.vertical ?? [])],
      horizontal: [...(subjectPatch.asymptotes?.horizontal ?? []), ...(kindPatch.asymptotes?.horizontal ?? []), ...(spec.asymptotes?.horizontal ?? [])],
      oblique: [...(subjectPatch.asymptotes?.oblique ?? []), ...(kindPatch.asymptotes?.oblique ?? []), ...(spec.asymptotes?.oblique ?? [])],
    },
  };
}
