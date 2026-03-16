import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthAdapter, AuthUser } from './types';

export class SupabaseAuthAdapter implements AuthAdapter {
  private client: SupabaseClient;
  loginUrl?: string;

  constructor(supabaseUrl: string, supabaseAnonKey: string, loginUrl?: string) {
    this.client = createClient(supabaseUrl, supabaseAnonKey);
    this.loginUrl = loginUrl;
  }

  async getUser(): Promise<AuthUser | null> {
    const { data: { session } } = await this.client.auth.getSession();
    if (!session?.user) return null;
    return { id: session.user.id, email: session.user.email };
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
