import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export class AuthRequestError extends Error {
  code: string;
  stage?: string;

  constructor(message: string, code: string, stage?: string) {
    super(message);
    this.name = 'AuthRequestError';
    this.code = code;
    this.stage = stage;
  }
}

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T> | T,
  options: { timeoutMs?: number; stage?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const stage = options.stage ?? 'request';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const task = Promise.resolve(fn(controller.signal));
    const timeoutTask = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new AuthRequestError("The request took too long. Please check your connection and try again.", "TIMEOUT", stage)), timeoutMs),
    );
    return await Promise.race([task, timeoutTask]);
  } catch (error: any) {
    if (error?.name === 'AbortError' || error === 'timeout') {
      throw new AuthRequestError('The request took too long. Please check your connection and try again.', 'TIMEOUT', stage);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns an Authorization header with the current Supabase session's access token.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Authenticated fetch wrapper — adds the Supabase Bearer token automatically.
 */
export async function authFetch(url: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  const { timeoutMs, ...fetchOptions } = options;
  return withTimeout((signal) => fetch(url, {
    ...fetchOptions,
    signal,
    headers: {
      ...authHeaders,
      ...(fetchOptions.headers || {}),
    },
  }), { timeoutMs: timeoutMs ?? 20_000, stage: `authFetch:${url}` });
}
