/** Scroll to a section without touching the router's location. */
function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Sticky "on this page" card for the right rail on desktop. */
export function Toc({ title, items }: { title: string; items: { id: string; label: string }[] }) {
  return (
    <aside className="hidden lg:block">
      <nav className="card sticky top-[76px] p-4">
        <p className="eyebrow mb-2 px-2">{title}</p>
        <ol className="space-y-0.5">
          {items.map((it) => (
            <li key={it.id}>
              <a href={`#${it.id}`} onClick={(e) => { e.preventDefault(); jump(it.id); }}
                className="block rounded-md px-2 py-1.5 text-[13px] leading-snug text-label-2 transition-colors hover:bg-fill-4 hover:text-label-1">
                {it.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </aside>
  );
}
