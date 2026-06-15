import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Isolate heavy third-party libs into their own chunks. Combined with
        // route-level React.lazy, these only download when a page that uses
        // them is opened (e.g. katex/markdown on a quiz, recharts on a
        // dashboard tab, the pdf stack on "Download report") rather than
        // bloating the initial app shell. They also cache independently of app
        // code, so app deploys don't force a re-download.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
          if (
            id.includes("katex") ||
            id.includes("react-markdown") ||
            id.includes("remark") ||
            id.includes("rehype") ||
            id.includes("micromark") ||
            id.includes("mdast")
          ) return "markdown";
          if (
            id.includes("html2pdf") ||
            id.includes("jspdf") ||
            id.includes("html2canvas")
          ) return "pdf";
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("@supabase")) return "supabase";
          return "vendor";
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
