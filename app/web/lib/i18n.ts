/**
 * Interface languages: en (default) and zh; the chosen one is kept in a cookie.
 * Strings are written inline as L(lang, 中文, English) — small enough not to need a key catalogue.
 * Case content (briefs, materials, personas) stays in the case's own language.
 */
import { createContext, useContext } from 'react';

export type Lang = 'zh' | 'en';
export const L = (lang: Lang, zh: string, en: string) => (lang === 'en' ? en : zh);

/** Interface languages, each named in its own language (for the language menu). Add new ones here. */
export const LANGUAGES: { code: Lang; name: string; short: string }[] = [
  { code: 'zh', name: '简体中文', short: '中' },
  { code: 'en', name: 'English', short: 'EN' },
];

const COOKIE = 'lang';

/** The saved choice if any; otherwise English, the site's default interface language. */
export function initialLang(): Lang {
  const m = /(?:^|; )lang=(zh|en)/.exec(document.cookie);
  return m ? (m[1] as Lang) : 'en';
}

export function saveLang(lang: Lang) {
  document.cookie = `${COOKIE}=${lang}; path=/; max-age=31536000; samesite=lax`;
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
}

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} });
export const useLang = () => useContext(LangContext);
