import { renderGraphSvgWithPython } from "../../services/pythonGraphRenderer";
import type { GraphQuestionSpec } from "@shared/schema";
export async function renderGraph(spec: GraphQuestionSpec) { return renderGraphSvgWithPython(spec); }
