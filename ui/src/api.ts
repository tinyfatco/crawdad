/**
 * API helpers — resolves paths relative to the current page base.
 *
 * When served via crawdad-cf proxy at /agents/{id}/, API calls need
 * to go through the same base path. When served directly on localhost:3002,
 * the base is just "/".
 */

/** Get the base path for API calls, derived from the current page URL. */
function getBasePath(): string {
  const path = window.location.pathname;
  // Ensure trailing slash
  return path.endsWith('/') ? path : path + '/';
}

/** Build a full URL for an API endpoint relative to the current base. */
export function apiUrl(endpoint: string): string {
  const base = getBasePath();
  // Strip leading slash from endpoint so it appends to base
  const relative = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return base + relative;
}

/** Upload files to the agent workspace. Returns list of uploaded paths. */
export async function uploadFiles(files: File[], targetDir = 'attachments'): Promise<string[]> {
  const form = new FormData();
  form.append('targetDir', targetDir);
  for (const file of files) {
    form.append('file', file, file.name);
  }
  const resp = await fetch(apiUrl('/api/upload'), { method: 'POST', body: form });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload failed: ${resp.status}`);
  }
  const data = await resp.json();
  return data.uploaded || [];
}
