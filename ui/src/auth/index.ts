import type { AuthAdapter } from './types';
import { NoopAuthAdapter } from './noop';
import { SupabaseAuthAdapter } from './supabase';

export type { AuthAdapter, AuthUser } from './types';

/** Create the auth adapter based on build-time env vars. */
export function createAuthAdapter(): AuthAdapter {
  const provider = import.meta.env.VITE_AUTH_PROVIDER || 'none';

  if (provider === 'supabase') {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const loginUrl = import.meta.env.VITE_LOGIN_URL;

    if (!url || !key) {
      console.warn('[auth] Supabase provider selected but VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing. Falling back to noop.');
      return new NoopAuthAdapter();
    }

    return new SupabaseAuthAdapter(url, key, loginUrl);
  }

  return new NoopAuthAdapter();
}
