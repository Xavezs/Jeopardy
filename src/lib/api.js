// src/lib/api.js
// Discord Activities run in a sandboxed iframe. In production and local tunnel
// testing, requests must stay relative so they pass through Vite's proxy or
// Discord's URL mappings set in the Developer Portal.
const API_BASE = import.meta.env.VITE_API_URL ?? '';

export async function api(path, options = {}) {
  const { headers, ...restOptions } = options;

  const res = await fetch(API_BASE + path, {
    credentials: 'include', // sends the httpOnly auth cookie
    headers: {
      'Content-Type': 'application/json',
      ...headers, // Safely merges custom headers without overwriting Content-Type
    },
    ...restOptions,
  });

  if (res.status === 401) {
    throw new Error('Not logged in');
  }

  if (!res.ok) {
    // Extract specific error messages returned by Express if present
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed: ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export { API_BASE };