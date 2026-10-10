import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

// A fenced block that names its language is coloured (see .hljs-* in styles.css); one that does not
// is left as it is, because guessing turns a folder listing or a log into confetti.
const HIGHLIGHT = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never;

export function Markdown({ children }: { children: string }) {
  return <div className="prose-fde"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={HIGHLIGHT}>{children}</ReactMarkdown></div>;
}

/** Minimal CSV parser (quotes, escaped quotes, CRLF) for viewing the client's exports. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text);
  const [head, ...body] = rows;
  if (!head) return null;
  return (
    <div>
      <table className="w-full text-[13px] tabular-nums">
        <thead className="sticky top-0 z-10 bg-layer-1 shadow-[0_1px_0_var(--color-divider)]">
          <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-medium text-label-3">{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className={`transition-colors hover:bg-fill-3 ${i % 2 ? 'bg-fill-4' : ''}`}>
              {r.map((c, j) => <td key={j} className="whitespace-nowrap px-3 py-1.5">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-divider px-3 py-2 text-xs text-label-3">{body.length} 行</p>
    </div>
  );
}
