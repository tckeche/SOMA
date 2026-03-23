export type IdentityHeaderName = "x-tutor-id" | "x-admin-id";

export function createIdentityHeaders(
  headerName: IdentityHeaderName,
  userId?: string | null,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };

  if (userId) {
    headers[headerName] = userId;
  }

  return headers;
}
