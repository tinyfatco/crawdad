/**
 * useConfig — fetch workspace configuration from /api/config.
 * Returns display_mode ('terminal' | 'desktop') and agent_name.
 */

import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '../api';

export interface WorkspaceConfig {
  display_mode: 'terminal' | 'desktop';
  agent_name: string;
}

async function fetchConfig(): Promise<WorkspaceConfig> {
  const response = await fetch(apiUrl('/api/config'));
  if (!response.ok) throw new Error('Failed to fetch config');
  return response.json();
}

export function useConfig() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: fetchConfig,
    staleTime: 0,
    retry: 2,
  });

  return {
    config: data ?? { display_mode: 'terminal' as const, agent_name: 'agent' },
    isLoading,
    error: error ? String(error) : null,
  };
}
