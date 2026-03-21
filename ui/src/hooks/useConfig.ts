/**
 * useConfig — fetch workspace configuration from /api/config.
 * Returns display_mode ('terminal' | 'desktop') and agent_name.
 * Retries on 503 (workspace not ready during cold start).
 */

import { useState, useEffect } from 'react';
import { apiUrl } from '../api';

export interface WorkspaceConfig {
  display_mode: 'terminal' | 'desktop';
  agent_name: string;
}

const DEFAULT_CONFIG: WorkspaceConfig = { display_mode: 'terminal', agent_name: 'agent' };

export function useConfig() {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Retry up to 15 times (covers ~30s cold start)
      for (let attempt = 0; attempt < 15; attempt++) {
        if (cancelled) return;
        try {
          const response = await fetch(apiUrl('/api/config'));
          if (response.status === 503) {
            // Workspace not ready — retry
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (!response.ok) throw new Error('Failed to fetch config');
          const data = await response.json();
          if (!cancelled) {
            setConfig(data);
            setIsLoading(false);
          }
          return;
        } catch (err) {
          if (attempt === 14 && !cancelled) {
            setError(err instanceof Error ? err.message : 'Config error');
            setIsLoading(false);
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return {
    config: config ?? DEFAULT_CONFIG,
    isLoading,
    error,
  };
}
