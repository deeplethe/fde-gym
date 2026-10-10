/**
 * The case library from the command line (`pnpm cases ...`, in app/). It talks to the same database
 * and object storage as the server, taken from the same environment variables.
 *
 *   pnpm cases import <folder>...   add or update cases: a case folder, or a folder of case folders
 *   pnpm cases list                 what is in the library
 *   pnpm cases hide <id>            take a case off offer (runs under way can finish)
 *   pnpm cases show <id>            put it back
 *   pnpm cases remove <id>          take a case out of the library (its runs are kept)
 */
import { importFolder } from './cases-store';
import { catalog, deleteCase, editCase } from './catalog';
import { closeDb, migrate } from './db';
import { ensureBucket, storageName } from './storage';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  if (!command || command === 'help' || command === '--help') {
    console.log('usage: pnpm cases import <folder>... | list | hide <id> | show <id> | remove <id>');
    return command ? 0 : 2;
  }
  await migrate();
  if (command === 'import') {
    if (!args.length) { console.error('give the folder that holds the cases'); return 2; }
    await ensureBucket();
    let bad = 0;
    for (const dir of args) {
      const r = await importFolder(dir);
      if (!r.imported.length && !r.failed.length) { console.error(`${dir}: no case folders in it`); bad++; }
      for (const x of r.imported) console.log(`${x.id.padEnd(28)} ${x.outcome.padEnd(10)} ${x.sha.slice(0, 12)}`);
      for (const f of r.failed) { console.error(`${f.id.padEnd(28)} failed     ${f.error}`); bad++; }
      if (r.data) console.log(`${'data/ beside the cases'.padEnd(28)} ${r.data}`);
    }
    console.log(`files are in ${storageName()}`);
    return bad ? 1 : 0;
  }
  if (command === 'list') {
    const cat = await catalog();
    for (const r of cat.records) console.log(`${r.card.id.padEnd(28)} ${(r.hidden ? 'hidden' : 'on offer').padEnd(9)} ${String(r.card.versions).padStart(2)} version${r.card.versions === 1 ? ' ' : 's'}  ${r.bundleSha.slice(0, 12)}  ${r.card.title}`);
    console.log(`${cat.records.length} case${cat.records.length === 1 ? '' : 's'}`);
    return 0;
  }
  if (['hide', 'show', 'remove'].includes(command)) {
    const id = args[0];
    if (!id) { console.error('give the case id'); return 2; }
    const ok = command === 'remove' ? await deleteCase(id) : await editCase(id, { hidden: command === 'hide' });
    if (!ok) { console.error(`no such case: ${id}`); return 1; }
    console.log(`${id}: ${{ hide: 'hidden', show: 'on offer', remove: 'removed' }[command]}`);
    return 0;
  }
  console.error(`unknown command: ${command}`);
  return 2;
}

main().then(async (code) => { await closeDb(); process.exit(code); }, async (e) => { console.error((e as Error).message); await closeDb().catch(() => undefined); process.exit(1); });
