// Small text helpers shared across surfaces.

// Clamp a string to at most `max` words, appending an ellipsis when truncated.
// Used as a safety net behind AI prompts that are instructed to stay within a
// word budget (e.g. the ≤30-word intervention flag, the ≤80-word profile
// summary) so the UI never blows its layout if the model overruns.
export function clampWords(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text.trim();
  return words.slice(0, max).join(" ").replace(/[.,;:]$/, "") + "…";
}
