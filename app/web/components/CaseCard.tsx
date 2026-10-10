import type { CaseCard as Card } from '../../server/catalog';
import { L, type Lang } from '@/lib/i18n';
import { difficultyLevel } from './ui';

export const difficultyLabel = (lang: Lang, d: string) => {
  const level = difficultyLevel(d);
  return level ? { easy: L(lang, '简单', 'Easy'), medium: L(lang, '中等', 'Medium'), hard: L(lang, '困难', 'Hard') }[level] : d;
};
export const regionLabel = (lang: Lang, r: string) => ({ CN: L(lang, '中国', 'China'), SG: L(lang, '新加坡', 'Singapore'), US: L(lang, '美国', 'United States') })[r] ?? r;
export const languageLabel = (lang: Lang, l: string) => (l.startsWith('zh') ? L(lang, '中文', 'Chinese') : L(lang, '英文', 'English'));
/** The sector in the case's own language. */
export const sectorLabel = (c: Card) => c.sector.label;

/** "Company · "the ask"" → the quoted ask, which is the hook of every case. */
export function splitTitle(title: string): { org: string; ask: string } {
  const m = /^(.*?)\s*[·:：]\s*(.*)$/.exec(title);
  return m ? { org: m[1], ask: m[2].replace(/^["“'「]|["”'」]$/g, '') } : { org: '', ask: title };
}
