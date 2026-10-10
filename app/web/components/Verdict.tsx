import type { Verdict as V } from '../../server/standings';
import { L, type Lang } from '@/lib/i18n';

const NAMES: Record<V, [string, string, string]> = {
  accepted: ['通过', 'Accepted', 'text-ok'],
  rejected: ['未通过', 'Not accepted', 'text-label-2'],
  incident: ['出了事故', 'Incident', 'text-bad'],
  judging: ['评分中', 'Judging', 'text-medium'],
  error: ['评分失败', 'Judge error', 'text-label-3'],
};

/** How a submission was judged, in a judge's own words and colours. */
export function Verdict({ verdict, lang, className = '' }: { verdict: V; lang: Lang; className?: string }) {
  const [zh, en, color] = NAMES[verdict];
  return <span className={`font-medium ${color} ${className}`}>{L(lang, zh, en)}</span>;
}
