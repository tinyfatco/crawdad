import { useMemo } from 'react';
import { createAuthAdapter } from './auth';
import { AuthProvider, AuthGate } from './auth/context';
import { WorkspaceLayout } from './components/WorkspaceLayout';

export default function App() {
  const adapter = useMemo(() => createAuthAdapter(), []);

  return (
    <AuthProvider adapter={adapter}>
      <AuthGate adapter={adapter}>
        <WorkspaceLayout />
      </AuthGate>
    </AuthProvider>
  );
}
