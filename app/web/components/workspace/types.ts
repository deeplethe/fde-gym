import type { Command, Message, Session } from '../../../server/session';

export type View = Awaited<ReturnType<Session['view']>>;
export type { Command, Message };

export const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** What the customer handed over (the brief, their documents and data, the harness's own tools) is to be read, not changed; the server keeps it so (KEPT in server/harness.ts). In the file tree these are the Background part. */
const KEPT = ['TASK.md', 'bin', 'docs', 'data'];
export const locked = (path: string) => KEPT.some((k) => path === k || path.startsWith(`${k}/`));
