/**
 * Dialog: a pane of thick glass over a dimmed page, with a title bar, a
 * scrolling body and a footer button bar. Same look as the dialogs in SessionPage.
 * Closes on the backdrop, the close button and Escape.
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Cross } from '@/components/ui';
import { L, type Lang } from '@/lib/i18n';

export function Modal({ title, children, onClose, lang, actions, width = 'max-w-lg' }: {
  title: ReactNode; children: ReactNode; onClose: () => void; lang: Lang; actions?: ReactNode;
  /** Tailwind max-width class for the card. */
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // On the body: a frosted ancestor would otherwise become the box a fixed overlay is laid out in.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 backdrop-blur-[3px]" onClick={onClose}>
      <div role="dialog" aria-modal="true" className={`flex max-h-[80vh] w-full ${width} flex-col overflow-hidden rounded-xl bg-layer-1 glass-thick shadow-menu`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-divider px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label={L(lang, '关闭', 'Close')} className="grid size-7 place-items-center rounded-md text-label-3 hover:bg-fill-3 hover:text-label-1"><Cross /></button>
        </div>
        <div className="space-y-3 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-divider px-5 py-3">
          {actions ?? <Button onClick={onClose} size="sm">{L(lang, '知道了', 'OK')}</Button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
