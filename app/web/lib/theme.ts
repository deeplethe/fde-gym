/**
 * Light / dark theme. index.html applies the saved choice (or the system setting) before the first
 * paint; this keeps it in sync afterwards. Until the user picks, the site follows the system.
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'fdegym:theme';

const saved = (): Theme | null => { try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; } catch { return null; } };
const system = (): Theme => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const apply = (t: Theme) => { document.documentElement.dataset.theme = t; };

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) ?? saved() ?? system());
  useEffect(() => {
    // Follow the system while the user hasn't chosen.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (!saved()) { const t = system(); apply(t); setThemeState(t); } };
    mq.addEventListener('change', onChange);
    // Keep several open tabs in step.
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) { const t = saved() ?? system(); apply(t); setThemeState(t); } };
    window.addEventListener('storage', onStorage);
    return () => { mq.removeEventListener('change', onChange); window.removeEventListener('storage', onStorage); };
  }, []);
  const setTheme = (t: Theme) => { try { localStorage.setItem(KEY, t); } catch { /* private mode */ } apply(t); setThemeState(t); };
  return { theme, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}
