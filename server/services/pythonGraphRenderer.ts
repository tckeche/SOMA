import path from "path";
import { spawn } from "child_process";
import type { GraphQuestionSpec } from "@shared/schema";

interface PythonGraphResult {
  ok: boolean;
  svg?: string;
  error?: string;
}

// Hard ceiling on a single render. Without it a wedged python3 child would
// leave the HTTP request hanging forever (the promise never resolves) and leak
// a process + an open socket per call — a trivial way to exhaust the box.
const RENDER_TIMEOUT_MS = Number(process.env.GRAPH_RENDER_TIMEOUT_MS || 10_000);
// Cap captured output so a runaway child cannot grow these buffers unbounded.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function renderGraphSvgWithPython(spec: GraphQuestionSpec): Promise<string | null> {
  const scriptPath = path.resolve(process.cwd(), "server/scripts/render_graph_svg.py");

  return new Promise((resolve) => {
    const child = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL — the child is CPU-bound matplotlib work that may ignore SIGTERM.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      console.warn("[python-graph-renderer] render timed out after", RENDER_TIMEOUT_MS, "ms");
      finish(null);
    }, RENDER_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });

    child.on("error", () => finish(null));

    child.on("close", () => {
      if (timedOut) return; // already settled by the timeout handler
      if (!stdout) return finish(null);
      try {
        const parsed = JSON.parse(stdout) as PythonGraphResult;
        if (parsed.ok && typeof parsed.svg === "string" && parsed.svg.trim().length > 0) {
          return finish(parsed.svg);
        }
      } catch {
        // noop
      }
      if (stderr) {
        console.warn("[python-graph-renderer] stderr:", stderr.slice(0, 500));
      }
      return finish(null);
    });

    // stdin can EPIPE if the child died immediately — swallow it so the
    // renderer degrades gracefully instead of crashing the process.
    child.stdin.on("error", () => finish(null));
    child.stdin.write(JSON.stringify({ spec }));
    child.stdin.end();
  });
}
