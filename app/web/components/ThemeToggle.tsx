import { L, useLang } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

/** Sun / moon button that switches between light and dark. */
export function ThemeToggle() {
  const { lang } = useLang();
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? L(lang, '切换到浅色', 'Switch to light') : L(lang, '切换到深色', 'Switch to dark');
  return (
    <button type="button" onClick={toggle} aria-label={label} title={label}
      className="grid size-8 place-items-center rounded-full text-label-2 transition-colors hover:bg-fill-3 hover:text-label-1">
      {theme === 'dark'
        ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="size-[17px]" aria-hidden><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" /></svg>
        : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" className="size-[17px]" aria-hidden><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" /></svg>}
    </button>
  );
}
