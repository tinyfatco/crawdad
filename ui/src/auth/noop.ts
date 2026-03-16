import type { AuthAdapter, AuthUser } from './types';

const NOOP_USER: AuthUser = { id: 'local', email: undefined };

/** Always authenticated. For local dev or self-hosted without auth. */
export class NoopAuthAdapter implements AuthAdapter {
  async getUser(): Promise<AuthUser> {
    return NOOP_USER;
  }

  onAuthChange(_callback: (user: AuthUser | null) => void): () => void {
    return () => {};
  }
}
