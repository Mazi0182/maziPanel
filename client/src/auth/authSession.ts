export interface UserSession {
  username: string;
  role: string;
  tokenVersion?: number;
  passwordHint?: string | null;
  bypassed?: boolean;
}

let memoryToken = '';

export function clearStoredToken(): void {
  memoryToken = '';
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('jwt');
    localStorage.removeItem('mazipanel_session');
    localStorage.removeItem('mazipanel_token');
  } catch {}
}

export function getStoredToken(): string {
  if (memoryToken) return memoryToken;
  try {
    return localStorage.getItem('mazipanel_token') || localStorage.getItem('token') || '';
  } catch {
    return '';
  }
}

export function setStoredToken(token: string): void {
  memoryToken = token || '';
  try {
    if (token) {
      localStorage.setItem('mazipanel_token', token);
    } else {
      clearStoredToken();
    }
  } catch {}
}

export async function apiLogout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch {}
  clearStoredToken();
  window.dispatchEvent(new CustomEvent('mazipanel:logout'));
}

export async function apiLogoutAll(): Promise<void> {
  try {
    await fetch('/api/auth/logout-all', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch {}
  clearStoredToken();
  window.dispatchEvent(new CustomEvent('mazipanel:logout'));
}

/**
 * Validates that an input URL is strictly same-origin with window.location.origin
 * and targets the exact /api boundary. Third-party URLs and external paths are excluded.
 */
function isStrictSameOriginApi(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false;

  let url: URL;
  try {
    if (typeof input === 'string') {
      url = new URL(input, window.location.origin);
    } else if (input instanceof URL) {
      url = input;
    } else if (input && typeof (input as Request).url === 'string') {
      url = new URL((input as Request).url, window.location.origin);
    } else {
      return false;
    }
  } catch {
    return false;
  }

  // Strict origin equality
  if (url.origin !== window.location.origin) {
    return false;
  }

  // Exact /api or /api/... path check
  const path = url.pathname;
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Backward-compatible fetchWithAuth for shared runtime hooks and components.
 * Scoped to same-origin /api requests; uses HttpOnly cookie session with same-origin credentials.
 */
export async function fetchWithAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (isStrictSameOriginApi(input)) {
    let headers: Headers;
    if (init?.headers) {
      headers = new Headers(init.headers);
    } else if (typeof input === 'object' && 'headers' in input && (input as Request).headers) {
      headers = new Headers((input as Request).headers);
    } else {
      headers = new Headers();
    }

    const token = getStoredToken();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const mergedInit: RequestInit = {
      ...init,
      headers,
      credentials: 'same-origin'
    };

    return fetch(input, mergedInit);
  }

  // Non-panel external fetch: preserve original semantics without forcing credentials
  return fetch(input, init);
}

export async function refreshSession(): Promise<UserSession | null> {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin'
    });
    if (res.ok) {
      const data = await res.json();
      return data.user || null;
    }
  } catch {}
  return null;
}

// Global fetch interceptor:
// Scoped STRICTLY to same-origin /api boundary so external calls (e.g. GitHub, Mojang) are untouched.
// Passes credentials: 'same-origin' and broadcasts 'mazipanel:unauthorized' upon 401 session expiry.
if (typeof window !== 'undefined' && !(window as any).__maziFetchIntercepted) {
  (window as any).__maziFetchIntercepted = true;
  const originalFetch = window.fetch;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isApi = isStrictSameOriginApi(input);

    let finalInit = init;
    if (isApi) {
      let headers: Headers;
      if (init?.headers) {
        headers = new Headers(init.headers);
      } else if (typeof input === 'object' && 'headers' in input && (input as Request).headers) {
        headers = new Headers((input as Request).headers);
      } else {
        headers = new Headers();
      }

      const token = getStoredToken();
      if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      finalInit = {
        ...init,
        headers,
        credentials: 'same-origin'
      };
    }

    const response = await originalFetch(input, finalInit);

    if (isApi && response.status === 401) {
      let pathname = '';
      try {
        if (typeof input === 'string') {
          pathname = new URL(input, window.location.origin).pathname;
        } else if (input instanceof URL) {
          pathname = input.pathname;
        } else if (input && typeof (input as Request).url === 'string') {
          pathname = new URL((input as Request).url, window.location.origin).pathname;
        }
      } catch {}

      // Ignore expected unauthenticated bootstrap status, me, and login queries
      if (
        pathname !== '/api/auth/login' &&
        pathname !== '/api/auth/status' &&
        pathname !== '/api/auth/setup' &&
        pathname !== '/api/auth/me'
      ) {
        clearStoredToken();
        window.dispatchEvent(new CustomEvent('mazipanel:unauthorized'));
      }
    }

    return response;
  };
}
