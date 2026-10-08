const API_BASE = import.meta.env.VITE_API_URL ?? '';

export async function api(path, options = {}) {
  const { headers, ...restOptions } = options;

  const res = await fetch(API_BASE + path, {
    credentials: 'include', // sends the httpOnly auth cookie
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...restOptions,
  });

  if (res.status === 401) {
    throw new Error('Not logged in');
  }

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed: ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export { API_BASE };