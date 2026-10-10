/**
 * The coding agent learners direct in the workspace: which model it is and what a run may spend.
 * Set in the admin pages; the site pays. The API key is stored encrypted and never sent back to the
 * browser. Until an admin fills this in, the agent uses the harness's own access (its key file,
 * proxy and default model), so a fresh install works where the harness does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetch as proxiedFetch, ProxyAgent } from 'undici';
import { z } from 'zod';
import { decrypt, encrypt, getSetting, putSetting } from './accounts';

interface Stored { enabled: boolean; baseUrl: string; model: string; key?: string; proxy: string; maxSteps: number; maxUsd: number }

export const AgentInput = z.object({
  enabled: z.boolean(),
  /** An OpenAI-compatible endpoint (chat completions with tool calling). */
  baseUrl: z.string().trim().url('请填写接口地址').max(300),
  model: z.string().trim().min(1, '请填写模型').max(200),
  /** Absent keeps the stored key, "" removes it (back to the harness's key file). */
  key: z.string().max(500).optional(),
  proxy: z.string().trim().max(300),
  /** Tool calls the agent may make for one message from the learner. */
  maxSteps: z.number().int().min(1).max(200),
  /** What one run may spend on the agent, in US dollars. */
  maxUsd: z.number().min(0.01).max(1000),
});

const KEY = 'agent';
const HARNESS_KEY_FILE = process.env.FDEGYM_OPENROUTER_KEY_FILE || join(homedir(), '.fdegym', 'openrouter_key');
const defaults = (): Stored => ({
  enabled: true, baseUrl: 'https://openrouter.ai/api/v1', model: process.env.FDEGYM_MODEL ?? 'deepseek/deepseek-v4-flash',
  proxy: process.env.FDEGYM_PROXY ?? '', maxSteps: 40, maxUsd: 1,
});
const load = async (): Promise<Stored> => ({ ...defaults(), ...await getSetting<Partial<Stored>>(KEY) });

/** The site's own model key, from the file the harness reads it from. */
export function harnessKey(): string | undefined {
  try { return existsSync(HARNESS_KEY_FILE) ? readFileSync(HARNESS_KEY_FILE, 'utf8').trim() || undefined : undefined; } catch { return undefined; }
}

export async function agentView() {
  const { key, ...s } = await load();
  return { ...s, hasKey: !!key, harnessKey: !key && !!harnessKey() };
}

export async function saveAgent(input: z.infer<typeof AgentInput>) {
  const old = await load();
  const key = input.key === undefined ? old.key : input.key === '' ? undefined : encrypt(input.key);
  await putSetting(KEY, { enabled: input.enabled, baseUrl: input.baseUrl.replace(/\/+$/, ''), model: input.model, key, proxy: input.proxy, maxSteps: input.maxSteps, maxUsd: input.maxUsd } satisfies Stored);
}

/** What a turn of the agent needs, or undefined when the agent is off or has no key to use. */
export async function agentConfig() {
  const s = await load();
  const key = s.key ? decrypt(s.key) : harnessKey();
  return s.enabled && key ? { baseUrl: s.baseUrl, model: s.model, key, proxy: s.proxy || undefined, maxSteps: s.maxSteps, maxUsd: s.maxUsd } : undefined;
}

export const agentAvailable = async () => !!(await agentConfig());

// ---- how much the model can read at once

const WINDOW_UNKNOWN = 128_000;
const windows = new Map<string, { size: number; until: number; asking?: Promise<number> }>();

/** What the provider's list of models says this one's context window is, in tokens (OpenRouter and others list it). */
async function listedWindow(cfg: { baseUrl: string; model: string; key: string; proxy?: string }): Promise<number | undefined> {
  const res = await proxiedFetch(`${cfg.baseUrl}/models`, {
    headers: { authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(8000),
    ...(cfg.proxy ? { dispatcher: new ProxyAgent(cfg.proxy) } : {}),
  });
  if (!res.ok) return undefined;
  const list = (await res.json() as { data?: { id?: string; context_length?: number; context_window?: number }[] }).data ?? [];
  const m = list.find((x) => x.id === cfg.model);
  const size = Number(m?.context_length ?? m?.context_window);
  return size > 0 ? size : undefined;
}

/**
 * The context window of the agent's model, in tokens: pi is told it (and summarises the conversation
 * as it nears it), and the workbench shows how full it is. FDEGYM_AGENT_CONTEXT if that is set;
 * otherwise what the provider lists for the model, asked once and kept for a day; 128000 where the
 * provider does not say. `wait: false` answers at once with what is known so far.
 */
export async function contextWindow(cfg: { baseUrl: string; model: string; key: string; proxy?: string }, wait = true): Promise<number> {
  const set = Number(process.env.FDEGYM_AGENT_CONTEXT);
  if (set > 0) return set;
  const key = `${cfg.baseUrl} ${cfg.model}`;
  const known = windows.get(key);
  if (known && known.until > Date.now()) return known.size;
  const asking = known?.asking ?? listedWindow(cfg).catch(() => undefined).then((size) => {
    // Not learnt (the provider does not list it, or could not be reached): asked again before long.
    windows.set(key, { size: size ?? known?.size ?? WINDOW_UNKNOWN, until: Date.now() + (size ? 86_400_000 : 300_000) });
    return windows.get(key)!.size;
  });
  windows.set(key, { size: known?.size ?? WINDOW_UNKNOWN, until: 0, asking });
  return wait ? asking : known?.size ?? WINDOW_UNKNOWN;
}
