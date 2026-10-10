import { ButtonLink, Card, container } from '@/components/ui';
import { L, useLang } from '@/lib/i18n';

export function NotFound() {
  const { lang } = useLang();
  return (
    <div className={`${container} py-16`}>
      <Card padded={false} className="mx-auto flex max-w-md flex-col items-center px-6 py-12 text-center">
        <span className="text-5xl font-semibold tabular-nums text-label-4">404</span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{L(lang, '没有这个页面', 'Page not found')}</h1>
        <div className="mt-6"><ButtonLink to="/cases" tone="secondary">{L(lang, '回到题库', 'Back to the cases')}</ButtonLink></div>
      </Card>
    </div>
  );
}
