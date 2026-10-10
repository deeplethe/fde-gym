/**
 * Admin requests. Signed-in admin accounts are recognised by their session cookie; the maintainer
 * token (FDEGYM_ADMIN_TOKEN) still works for first set-up and scripts. It is kept in this tab only
 * (sessionStorage) and sent as a bearer token.
 */
import { useCallback, useState } from 'react';
import { api } from './client';

const KEY = 'fdegym:admin-token';
const readToken = () => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };

export function useAdminToken() {
  const [token, setTokenState] = useState(readToken);
  const signIn = useCallback((t: string) => { try { sessionStorage.setItem(KEY, t); } catch { /* private mode */ } setTokenState(t); }, []);
  const signOut = useCallback(() => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } setTokenState(''); }, []);
  /** Fetch an admin endpoint with the token. */
  const adminApi = useCallback(<T,>(url: string, init: Parameters<typeof api>[1] = {}) =>
    api<T>(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { authorization: `Bearer ${token}` } : {}) } }), [token]);
  return { token, signIn, signOut, adminApi };
}

export type AdminApi = ReturnType<typeof useAdminToken>['adminApi'];

/** Download an admin CSV export (needs the same credentials as adminApi). */
export async function downloadCsv(url: string, name: string, token: string) {
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
