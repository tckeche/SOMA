export function parseId(value: unknown): number {
  return parseInt(String(value), 10);
}
export function documentRole(value: unknown): "worksheet" | "exam_paper" | "supporting_resource" {
  return value === "exam_paper" || value === "supporting_resource" ? value : "worksheet";
}
