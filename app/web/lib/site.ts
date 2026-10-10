/** Public site settings (sign-up mode, anonymous practice, case authoring), fetched once and shared. */
import { useEffect, useState } from 'react';
import { api } from './client';

export interface SiteConfig {
  registration: 'open' | 'email' | 'closed'; closedMessage: string; allowAnonymous: boolean;
  /** Members may write their own cases (/my/cases). */
  userCases: boolean;
}

let cache: Promise<SiteConfig> | undefined;
const fallback: SiteConfig = { registration: 'open', closedMessage: '', allowAnonymous: true, userCases: false };

export function siteConfig(): Promise<SiteConfig> {
  cache ??= api<SiteConfig>('/api/auth/config').catch(() => fallback);
  return cache;
}

/** Drop the cached copy, e.g. after an admin changes a setting. */
export function refreshSiteConfig() { cache = undefined; return siteConfig(); }

/** undefined while loading. */
export function useSiteConfig(): SiteConfig | undefined {
  const [c, setC] = useState<SiteConfig>();
  useEffect(() => { let live = true; void siteConfig().then((v) => { if (live) setC(v); }); return () => { live = false; }; }, []);
  return c;
}
