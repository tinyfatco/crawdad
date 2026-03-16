export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthAdapter {
  /** Check current session, return user or null */
  getUser(): Promise<AuthUser | null>;
  /** Subscribe to auth state changes. Returns unsubscribe function. */
  onAuthChange(callback: (user: AuthUser | null) => void): () => void;
  /** Where to send unauthenticated users. Null = return 401, no redirect. */
  loginUrl?: string;
}
