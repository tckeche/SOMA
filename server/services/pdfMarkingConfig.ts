import { z } from "zod";

const bool = (v: string | undefined, d: boolean) => v == null ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());
const int = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const providerSchema = z.enum(["openai", "anthropic", "google"]);
export type PdfProviderName = z.infer<typeof providerSchema>;
export interface PdfMarkingConfig { enabled: boolean; workerEnabled: boolean; markerAProvider?: PdfProviderName; markerAModel?: string; markerBProvider?: PdfProviderName; markerBModel?: string; allowSameProvider: boolean; requireTutorApproval: boolean; maxPages: number; maxAttempts: number; providerTimeoutMs: number; configured: boolean; configurationError: string | null; }
export function getPdfMarkingConfig(env = process.env): PdfMarkingConfig {
  const enabled = bool(env.PDF_DUAL_MARKING_ENABLED, false); const allowSameProvider = bool(env.PDF_MARKING_ALLOW_SAME_PROVIDER, false);
  const a = providerSchema.safeParse(env.PDF_MARKER_A_PROVIDER); const b = providerSchema.safeParse(env.PDF_MARKER_B_PROVIDER);
  let configurationError: string | null = null;
  if (enabled) { if (!a.success || !b.success || !env.PDF_MARKER_A_MODEL || !env.PDF_MARKER_B_MODEL) configurationError = "Two configured PDF vision providers and models are required."; else if (!allowSameProvider && a.data === b.data) configurationError = "PDF marker providers must be independent unless explicitly allowed."; }
  return { enabled, workerEnabled: bool(env.PDF_MARKING_WORKER_ENABLED, false), markerAProvider: a.success ? a.data : undefined, markerAModel: env.PDF_MARKER_A_MODEL, markerBProvider: b.success ? b.data : undefined, markerBModel: env.PDF_MARKER_B_MODEL, allowSameProvider, requireTutorApproval: bool(env.PDF_MARKING_REQUIRE_TUTOR_APPROVAL, true), maxPages: int(env.PDF_MARKING_MAX_PAGES, 50), maxAttempts: int(env.PDF_MARKING_MAX_ATTEMPTS, 3), providerTimeoutMs: int(env.PDF_MARKING_PROVIDER_TIMEOUT_MS, 120000), configured: enabled && configurationError === null, configurationError };
}
export function assertIndependentProviders(config = getPdfMarkingConfig()): void { if (!config.enabled) throw new Error("PDF dual marking is disabled"); if (config.configurationError) throw new Error(config.configurationError); }
