/**
 * Who is using the site: the signed-in account (if any) and the practice identity. Shared by every
 * component through one cached request; call `refreshMe()` after signing in or out.
 */
import { useEffect, useState } from 'react';
import { api } from './client';

export interface Account { id: string; email: string; name: string; role: 'user' | 'admin' }
export interface Me { learner: { name: string } | null; user: Account | null }

let cache: Promise<Me> | undefined;
const listeners = new Set<(m: Me) => void>();

function fetchMe(): Promise<Me> {
  cache ??= api<Me>('/api/me').catch(() => ({ learner: null, user: null }));
  return cache;
}

/** Re-read /api/me and update every component using `useMe`. */
export async function refreshMe(): Promise<Me> {
  cache = undefined;
  const me = await fetchMe();
  for (const l of listeners) l(me);
  return me;
}

/** undefined while loading. */
export function useMe(): Me | undefined {
  const [me, setMe] = useState<Me>();
  useEffect(() => {
    let live = true;
    void fetchMe().then((m) => { if (live) setMe(m); });
    listeners.add(setMe);
    return () => { live = false; listeners.delete(setMe); };
  }, []);
  return me;
}
