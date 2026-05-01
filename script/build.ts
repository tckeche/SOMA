import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
import { execSync } from "child_process";
import { readFileSync } from "fs";

/** Resolve the git commit SHA the bundle is being built from. Tried in
 *  order: GIT_COMMIT_SHA env var (CI/Replit may set it), `git rev-parse
 *  HEAD`, then reading .git/HEAD directly. Result is baked into the
 *  bundle via esbuild's `define`, so /api/health/version can echo it
 *  back at runtime without needing .git/ in the deployment container. */
function resolveCommitSha(): string {
  if (process.env.GIT_COMMIT_SHA) return process.env.GIT_COMMIT_SHA.trim();
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    // fall through
  }
  try {
    const head = readFileSync(".git/HEAD", "utf8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice("ref: ".length);
      return readFileSync(`.git/${ref}`, "utf8").trim();
    }
    return head;
  } catch {
    return "unknown";
  }
}

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "jsonwebtoken",
  "multer",
  "nanoid",
  "openai",
  "pg",
  "ws",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  const commitSha = resolveCommitSha();
  const buildTime = new Date().toISOString();
  console.log(`bundling commit: ${commitSha} at ${buildTime}`);

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
      // Baked into the bundle so /api/health/version can return them
      // without filesystem reads. JSON.stringify gives us properly
      // quoted string literals that esbuild substitutes verbatim.
      __BUILD_COMMIT_SHA__: JSON.stringify(commitSha),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
