export const SOMA_DATA_EVENT = "soma:data-mutated";

type SomaMutationType =
  | "assessment_created"
  | "assessment_assigned"
  | "assessment_submitted"
  | "review_published"
  | "status_changed"
  | "assessment_deleted";

interface SomaMutationPayload {
  type: SomaMutationType;
  quizId?: number;
}

export function emitSomaMutation(payload: SomaMutationPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SOMA_DATA_EVENT, { detail: payload }));
}

export function subscribeToSomaMutations(handler: (payload: SomaMutationPayload) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const custom = event as CustomEvent<SomaMutationPayload>;
    if (!custom.detail) return;
    handler(custom.detail);
  };
  window.addEventListener(SOMA_DATA_EVENT, listener);
  return () => window.removeEventListener(SOMA_DATA_EVENT, listener);
}
