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
