import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "next-themes";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" enableSystem={false} storageKey="mathquizhub-theme">
      <App />
    </ThemeProvider>
  </QueryClientProvider>,
);
