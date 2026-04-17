import path from "path";
import { spawn } from "child_process";
import type { GraphQuestionSpec } from "@shared/schema";

interface PythonGraphResult {
  ok: boolean;
  svg?: string;
  error?: string;
}

export async function renderGraphSvgWithPython(spec: GraphQuestionSpec): Promise<string | null> {
  const scriptPath = path.resolve(process.cwd(), "server/scripts/render_graph_svg.py");

  return new Promise((resolve) => {
    const child = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", () => resolve(null));

    child.on("close", () => {
      if (!stdout) return resolve(null);
      try {
        const parsed = JSON.parse(stdout) as PythonGraphResult;
        if (parsed.ok && typeof parsed.svg === "string" && parsed.svg.trim().length > 0) {
          return resolve(parsed.svg);
        }
      } catch {
        // noop
      }
      if (stderr) {
        console.warn("[python-graph-renderer] stderr:", stderr.slice(0, 500));
      }
      return resolve(null);
    });

    child.stdin.write(JSON.stringify({ spec }));
    child.stdin.end();
  });
}
