/**
 * useConfig — fetch workspace configuration from /api/config.
 * Returns display_mode ('terminal' | 'desktop') and agent_name.
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
      try {
        const response = await fetch(apiUrl('/api/config'));
        if (!response.ok) throw new Error('Failed to fetch config');
        const data = await response.json();
        if (!cancelled) {
          setConfig(data);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Config error');
          setIsLoading(false);
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
