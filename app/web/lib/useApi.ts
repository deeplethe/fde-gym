import { useCallback, useEffect, useState } from 'react';
import { api } from './client';

/** GET a JSON endpoint; `reload` refetches. */
export function useApi<T>(url: string | undefined) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    if (!url) return Promise.resolve();
    setLoading(true);
    return api<T>(url).then((d) => { setData(d); setError(undefined); }).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [url]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}
