/**
 * Getting cases into the library and back out to the harness.
 *
 * In: a case is authored as a folder (its briefs, world, generators, grader). Importing one reads
 * what the site may show of it into the `cases` table, packs the folder into one archive and puts
 * that in object storage under a name made of the hash of its files:
 *
 *     cases/<id>/<sha256>.tar.gz
 *
 * Importing the same files again changes nothing; importing changed files adds a new archive and
 * points the row at it. Old archives are left where they are.
 *
 * Out: the harness executes a case's own Python, so a machine that runs a case fetches the archive
 * of the version the run is on and unpacks it (./case-cache). This module is where the site's own
 * copy comes from: its object storage.
 *
 * A few cases read data that is kept beside the cases folder rather than in it (data/ next to
 * cases/, such as a public dataset with a licence of its own). That folder is one more archive,
 * shared by every case: see `importSharedData`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { getSetting, putSetting } from './accounts';
import { isCaseId, isCaseSha, setCaseSource, unpack } from './case-cache';
import { BRIEF, invalidateCatalog, type CaseCard, type Variant } from './catalog';
import { db, json } from './db';
import { getObject, hasObject, putObject } from './storage';

export { isCaseId } from './case-cache';

const NEEDED = ['engagement.json', 'npcs.json', 'build_world.py', 'grader.py', `briefs/${BRIEF}.md`];
const SKIP = new Set(['__pycache__', '.DS_Store', '.git']);
const MAX_ARCHIVE = 64 * 1024 * 1024;
export const looksLikeCase = (dir: string) => NEEDED.every((f) => existsSync(join(dir, f)));

/** How a case is filed when it is first imported (organisation, sector, region, difficulty), by case id. Admins can change it afterwards. */
const SEED_FILE = join(dirname(fileURLToPath(import.meta.url)), '../catalog.json');
type Seed = { org?: string; sector?: string; region?: string; difficulty?: string };
const seeds = (): Record<string, Seed> => (existsSync(SEED_FILE) ? JSON.parse(readFileSync(SEED_FILE, 'utf8')) : {});

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// ---- reading a case folder

/**
 * Briefs and npcs.json may carry {{name}} placeholders that the harness fills from the case's
 * variants.json when it builds a run. The site shows the case as written, so it fills them the
 * same way from the `base` variant. `asJson`: the text sits inside JSON, so values are escaped; a
 * placeholder with no value becomes 0, which is valid both inside a string and as a bare value.
 */
function render(text: string, params: Record<string, unknown>, asJson = false): string {
  return text.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_m, k: string) => {
    if (!(k in params)) return asJson ? '0' : '';
    const v = String(params[k]);
    return asJson ? JSON.stringify(v).slice(1, -1) : v;
  });
}

interface Listing {
  ask: string; sponsor: string; org: string;
  people: CaseCard['people']; variants: Variant[]; features: CaseCard['features'];
}

/**
 * What the site may show of a case, from its folder. Only what a candidate knows before starting
 * is read: the sponsor's ask in the brief and the people in the directory. engagement.json's own
 * title, NOTES.md and truth.json say what the case is really about, so nothing here reads them.
 */
function readListing(dir: string): Listing {
  const all: Record<string, { angle?: unknown }> = existsSync(join(dir, 'variants.json')) ? readJson(join(dir, 'variants.json')) : {};
  const params = (all.base ?? {}) as Record<string, unknown>;
  const brief = render(readFileSync(join(dir, 'briefs', `${BRIEF}.md`), 'utf8'), params);
  const ask = (/^#\s*(?:Engagement:\s*)?(.+)$/m.exec(brief)?.[1].trim() ?? basename(dir)).replace(/^./, (x) => x.toUpperCase());
  const sponsor = /\*\*Sponsor:\s*(.+?)\*\*/.exec(brief)?.[1].trim() ?? '';
  const cfg = readJson(join(dir, 'engagement.json'));
  const npcs = JSON.parse(render(readFileSync(join(dir, 'npcs.json'), 'utf8'), params, true));
  return {
    ask, sponsor,
    // "Name, role, organisation": the organisation is the last part.
    org: sponsor.includes(',') ? sponsor.split(',').pop()!.replace(/\s*\(.*\)\s*$/, '').trim() : '',
    people: (npcs.npcs as { id: string; name: string; role: string; blurb: string }[]).map((n) => ({ id: n.id, name: n.name, title: n.role, profile: n.blurb })),
    variants: [{ key: 'base' }, ...Object.keys(all).filter((k) => k !== 'base').map((key) => ({ key, ...(typeof all[key]?.angle === 'string' && all[key].angle ? { angle: all[key].angle as string } : {}) }))],
    features: {
      pilot: existsSync(join(dir, 'pilot.py')), clock: !!npcs.clock, llm: !!cfg.llm,
      services: ((cfg.services ?? []) as { name: string }[]).map((s) => s.name),
    },
  };
}

// ---- packing

/** Every file under `dir`, as sorted paths with forward slashes. Links are left out: an archive holds files only. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      // Left out: caches, and the `._name` files macOS tar adds beside every file it packs.
      if (SKIP.has(name) || name.endsWith('.pyc') || name.startsWith('._')) continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path); else if (st.isFile()) out.push(path);
    }
  };
  walk('');
  return out;
}

/** The hash of a folder's files (names and contents), which is what a version of a case is. */
function hashOf(dir: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of files) h.update(f).update('\0').update(createHash('sha256').update(readFileSync(join(dir, f))).digest()).update('\0');
  return h.digest('hex');
}

/** `dir` as a .tar.gz with one top folder, `top`. */
async function pack(dir: string, top: string, files: string[]): Promise<Buffer> {
  // tar names entries by their path under cwd, so the folder is given the name it must have in the archive.
  const stage = mkdtempSync(join(tmpdir(), 'fdegym-pack-'));
  try {
    for (const f of files) {
      const to = join(stage, top, f);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(dir, f)));
    }
    const chunks: Buffer[] = [];
    for await (const c of tar.create({ gzip: true, cwd: stage, portable: true }, [top])) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ---- importing

const bundleKey = (id: string, sha: string) => `cases/${id}/${sha}.tar.gz`;

export type Imported = { id: string; outcome: 'added' | 'updated' | 'unchanged'; sha: string };

/** Bring one case folder into the library (or bring the library up to the folder's current files). */
export async function importCase(dir: string): Promise<Imported> {
  dir = resolve(dir);
  const id = basename(dir);
  if (!isCaseId(id)) throw new Error(`${id}: a case folder is named with lower-case letters, digits and underscores`);
  const missing = NEEDED.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`${id}: not a case (no ${missing.join(', ')})`);
  const files = filesIn(dir);
  const sha = hashOf(dir, files);
  const had = await db.one<{ bundle_sha: string }>('SELECT bundle_sha FROM cases WHERE id = $1', [id]);
  const key = bundleKey(id, sha);
  // The archive goes up first: a row must never point at something that is not there.
  let bytes = 0;
  if (had?.bundle_sha !== sha || !(await hasObject(key))) {
    const archive = await pack(dir, id, files);
    if (archive.length > MAX_ARCHIVE) throw new Error(`${id}: the case is ${Math.round(archive.length / 1e6)} MB packed; the limit is ${MAX_ARCHIVE / 1024 / 1024} MB`);
    await putObject(key, archive, 'application/gzip');
    bytes = archive.length;
  } else if (had) {
    return { id, outcome: 'unchanged', sha };
  }
  const l = readListing(dir);
  const seed = seeds()[id] ?? {};
  const now = Date.now();
  // How the case is filed and whether it is on offer are the admins' to set, so an update leaves them alone.
  await db.run(`
    INSERT INTO cases (id, ask, sponsor, org, sector, region, difficulty, people, variants, features, bundle_key, bundle_sha, bundle_bytes, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $14)
    ON CONFLICT (id) DO UPDATE SET ask = EXCLUDED.ask, sponsor = EXCLUDED.sponsor, people = EXCLUDED.people,
      variants = EXCLUDED.variants, features = EXCLUDED.features, bundle_key = EXCLUDED.bundle_key, bundle_sha = EXCLUDED.bundle_sha,
      bundle_bytes = EXCLUDED.bundle_bytes, updated_at = EXCLUDED.updated_at`,
  [id, l.ask, l.sponsor, seed.org ?? l.org, seed.sector ?? 'Other', seed.region ?? '', seed.difficulty ?? '', json(l.people), json(l.variants), json(l.features), key, sha, bytes, now]);
  invalidateCatalog();
  return { id, outcome: had ? 'updated' : 'added', sha };
}

/**
 * Import every case folder in `dir` (or `dir` itself, when it is one). A folder that cannot be
 * imported is reported and the rest go on. Data kept beside the cases folder comes along.
 */
export async function importFolder(dir: string): Promise<{ imported: Imported[]; failed: { id: string; error: string }[]; data?: 'stored' | 'unchanged' }> {
  dir = resolve(dir);
  if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`);
  const single = looksLikeCase(dir);
  const dirs = single ? [dir] : readdirSync(dir).sort().map((n) => join(dir, n)).filter((d) => isCaseId(basename(d)) && lstatSync(d).isDirectory() && looksLikeCase(d));
  const imported: Imported[] = [], failed: { id: string; error: string }[] = [];
  for (const d of dirs) {
    try { imported.push(await importCase(d)); } catch (e) { failed.push({ id: basename(d), error: (e as Error).message }); }
  }
  const beside = join(dirname(single ? dirname(dir) : dir), 'data');
  const data = existsSync(join(beside, 'raw')) ? await importSharedData(beside) : undefined;
  return { imported, failed, ...(data ? { data } : {}) };
}

/** Import a case uploaded as a .tar.gz of its folder. */
export async function importArchive(archive: Buffer): Promise<Imported> {
  if (archive.length > MAX_ARCHIVE) throw new Error(`the archive is larger than ${MAX_ARCHIVE / 1024 / 1024} MB`);
  const stage = mkdtempSync(join(tmpdir(), 'fdegym-upload-'));
  try {
    try { await unpack(archive, stage); } catch { throw new Error('not a .tar.gz archive'); }
    const tops = readdirSync(stage).filter((n) => lstatSync(join(stage, n)).isDirectory());
    const found = looksLikeCase(stage) ? undefined : tops.find((n) => looksLikeCase(join(stage, n)));
    if (!found) throw new Error('the archive must hold one case folder (with engagement.json, npcs.json, build_world.py, grader.py and briefs/L3.md in it)');
    return await importCase(join(stage, found));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ---- data shared by cases (data/ beside the cases folder)

interface SharedData { sha: string; key: string; bytes: number }
const SHARED = 'shared-data';

/** Store the folder's `raw/` (what is fetched or licensed separately; anything else in it is rebuilt). */
export async function importSharedData(dataDir: string): Promise<'stored' | 'unchanged'> {
  const raw = join(resolve(dataDir), 'raw');
  const files = filesIn(raw);
  const sha = hashOf(raw, files);
  const key = `shared/data/${sha}.tar.gz`;
  if ((await getSetting<SharedData>(SHARED))?.sha === sha && await hasObject(key)) return 'unchanged';
  const archive = await pack(raw, 'raw', files);
  await putObject(key, archive, 'application/gzip');
  await putSetting(SHARED, { sha, key, bytes: archive.length } satisfies SharedData);
  return 'stored';
}

// ---- where a machine that runs cases gets them from

/** The archive of one version of a case, for the site itself and for the sandbox machines that ask it. */
export async function caseArchive(id: string, sha: string): Promise<Buffer> {
  if (!isCaseId(id) || !isCaseSha(sha)) throw new Error('not a case version');
  return getObject(bundleKey(id, sha));
}

/** The data shared by cases, if any has been stored. */
export async function sharedData(): Promise<{ sha: string; archive(): Promise<Buffer> } | undefined> {
  const s = await getSetting<SharedData>(SHARED);
  return s && { sha: s.sha, archive: () => getObject(s.key) };
}

/** On the site, cases come straight from object storage. */
export function casesFromStorage() { setCaseSource({ bundle: caseArchive, shared: sharedData }); }
