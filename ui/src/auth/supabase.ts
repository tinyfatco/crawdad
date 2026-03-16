import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthAdapter, AuthUser } from './types';

/**
 * Parse the Supabase auth cookie and extract the session tokens.
 * The cookie is a JSON-encoded array of chunks (for large tokens).
 * Format: sb-{ref}-auth-token = base64(JSON.stringify({access_token, refresh_token, ...}))
 */
function getSessionFromCookies(supabaseUrl: string): { access_token: string; refresh_token: string } | null {
  try {
    // Extract project ref from URL: https://xxxx.supabase.co -> xxxx
    const ref = new URL(supabaseUrl).hostname.split('.')[0];
    const cookieName = `sb-${ref}-auth-token`;

    // Read cookie value
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
    if (!match) return null;

    let decoded = decodeURIComponent(match[1]);

    // Supabase SSR cookies use "base64-" prefix
    if (decoded.startsWith('base64-')) {
      decoded = atob(decoded.slice(7));
    }

    const parsed = JSON.parse(decoded);

    if (parsed.access_token && parsed.refresh_token) {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

export class SupabaseAuthAdapter implements AuthAdapter {
  private client: SupabaseClient;
  private supabaseUrl: string;
  loginUrl?: string;

  constructor(supabaseUrl: string, supabaseAnonKey: string, loginUrl?: string) {
    this.supabaseUrl = supabaseUrl;
    this.client = createClient(supabaseUrl, supabaseAnonKey);
    this.loginUrl = loginUrl;
  }

  async getUser(): Promise<AuthUser | null> {
    // First try localStorage (same-origin, normal flow)
    const { data: { session } } = await this.client.auth.getSession();
    if (session?.user) {
      return { id: session.user.id, email: session.user.email };
    }

    // Fall back to cookie (cross-subdomain flow)
    const cookieSession = getSessionFromCookies(this.supabaseUrl);
    if (cookieSession) {
      const { data, error } = await this.client.auth.setSession({
        access_token: cookieSession.access_token,
        refresh_token: cookieSession.refresh_token,
      });
      if (data.session?.user && !error) {
        return { id: data.session.user.id, email: data.session.user.email };
      }
    }

    return null;
  }

  onAuthChange(callback: (user: AuthUser | null) => void): () => void {
    const { data: { subscription } } = this.client.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        callback({ id: session.user.id, email: session.user.email });
      } else {
        callback(null);
      }
    });
    return () => subscription.unsubscribe();
  }
}
