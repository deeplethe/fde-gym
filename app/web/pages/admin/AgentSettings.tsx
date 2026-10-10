/** The coding agent learners direct in the workspace: which model it is and what a run may spend. The site pays. */
import { useEffect, useState } from 'react';
import { Button, Card, Pill, SectionTitle } from '@/components/ui';
import type { AdminApi } from '@/lib/admin';
import { L, type Lang } from '@/lib/i18n';

interface AgentView { enabled: boolean; baseUrl: string; model: string; proxy: string; maxSteps: number; maxUsd: number; hasKey: boolean; harnessKey: boolean }
type Form = { enabled: boolean; baseUrl: string; model: string; proxy: string; maxSteps: string; maxUsd: string; key: string };
const toForm = (v: AgentView): Form => ({ enabled: v.enabled, baseUrl: v.baseUrl, model: v.model, proxy: v.proxy, maxSteps: String(v.maxSteps), maxUsd: String(v.maxUsd), key: '' });

export function AdminAgent({ adminApi, lang }: { adminApi: AdminApi; lang: Lang }) {
  const [view, setView] = useState<AgentView>();
  const [form, setForm] = useState<Form>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    adminApi<AgentView>('/api/admin/settings/agent').then((v) => { setView(v); setForm(toForm(v)); }).catch((e) => setError((e as Error).message));
  }, [adminApi]);
  const set = (change: Partial<Form>) => { setForm((f) => (f ? { ...f, ...change } : f)); setSaved(false); };

  async function save(clearKey = false) {
    if (!form) return;
    setSaving(true); setError(undefined);
    try {
      const next = await adminApi<AgentView>('/api/admin/settings/agent', {
        method: 'PUT',
        json: { enabled: form.enabled, baseUrl: form.baseUrl, model: form.model, proxy: form.proxy, maxSteps: Number(form.maxSteps), maxUsd: Number(form.maxUsd), ...(clearKey ? { key: '' } : form.key ? { key: form.key } : {}) },
      });
      setView(next); setForm(toForm(next)); setSaved(true);
    } catch (e) { setError((e as Error).message); }
    setSaving(false);
  }

  if (!view || !form) return <p className="mt-5 text-sm text-label-3">{error ?? L(lang, '加载中……', 'Loading…')}</p>;
  const usable = view.enabled && (view.hasKey || view.harnessKey);
  return (
    <div className="mt-5 space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionTitle className="!mb-0" sub={L(lang, '学员在做题页里指挥的 coding agent。模型费用由网站出。', 'The coding agent learners direct in the workspace. The site pays for the model.')}>
            {L(lang, '助手', 'Agent')}
          </SectionTitle>
          {usable ? <Pill tone="ok">{L(lang, '可用', 'Available')}</Pill> : <Pill tone="warn">{view.enabled ? L(lang, '没有密钥', 'No key') : L(lang, '已关闭', 'Off')}</Pill>}
        </div>

        <div className="mt-4 rounded-lg bg-fill-4 px-4 py-3 text-[13px] leading-relaxed text-label-2">
          {L(lang, '助手是 pi，在沙箱机上运行，模型请求经本站转发。接口要兼容 OpenAI 的 chat completions，支持工具调用和流式输出（OpenRouter 可以直接用）。写代码需要像样的模型：便宜的模型能跑，但经常改不对。关掉助手后，学员只能用终端手动做。',
            'The agent is pi, run on the runner; its model calls go through this site. The endpoint must be OpenAI-compatible chat completions with tool calling and streaming (OpenRouter works as is). Writing code takes a capable model: a cheap one runs, but often gets the change wrong. With the agent off, learners work by hand in the terminal.')}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off" className="mt-5 grid max-w-3xl gap-4 sm:grid-cols-6">
          <div className="flex items-center justify-between gap-4 sm:col-span-6">
            <span className="text-sm font-medium">{L(lang, '开放助手', 'Agent on')}</span>
            <button type="button" role="switch" aria-checked={form.enabled} aria-label={L(lang, '开放助手', 'Agent on')} onClick={() => set({ enabled: !form.enabled })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${form.enabled ? 'bg-brand' : 'bg-fill-1'}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${form.enabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <label className="block sm:col-span-6">
            <span className="field-label">{L(lang, '接口地址', 'Endpoint')}</span>
            <input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://openrouter.ai/api/v1" spellCheck={false} className="field font-mono text-[13px]" />
          </label>
          <label className="block sm:col-span-6">
            <span className="field-label">{L(lang, '模型', 'Model')}</span>
            <input value={form.model} onChange={(e) => set({ model: e.target.value })} spellCheck={false} className="field font-mono text-[13px]" />
          </label>
          <label className="block sm:col-span-6">
            <span className="field-label">{L(lang, 'API 密钥', 'API key')}</span>
            <input type="password" value={form.key} onChange={(e) => set({ key: e.target.value })} autoComplete="new-password" spellCheck={false} className="field font-mono text-[13px]"
              placeholder={view.hasKey ? L(lang, '已保存；留空则不改', 'Saved; leave empty to keep it') : view.harnessKey ? L(lang, '未填写：正在用 harness 的密钥文件', 'Not set: using the harness’s key file') : L(lang, '未填写', 'Not set')} />
            {view.hasKey && <button type="button" onClick={() => void save(true)} className="mt-1.5 text-xs text-link hover:underline">{L(lang, '清除已保存的密钥，改用 harness 的密钥文件', 'Remove the saved key and use the harness’s key file')}</button>}
          </label>
          <label className="block sm:col-span-6">
            <span className="field-label">{L(lang, 'HTTP 代理（可留空）', 'HTTP proxy (optional)')}</span>
            <input value={form.proxy} onChange={(e) => set({ proxy: e.target.value })} placeholder="http://127.0.0.1:8080" spellCheck={false} className="field font-mono text-[13px]" />
          </label>
          <label className="block sm:col-span-3">
            <span className="field-label">{L(lang, '每条消息最多几步', 'Steps per message')}</span>
            <input value={form.maxSteps} onChange={(e) => set({ maxSteps: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className="field font-mono tabular-nums" />
          </label>
          <label className="block sm:col-span-3">
            <span className="field-label">{L(lang, '每次练习的花费上限（美元）', 'Spend per run (USD)')}</span>
            <input value={form.maxUsd} onChange={(e) => set({ maxUsd: e.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" className="field font-mono tabular-nums" />
          </label>
          <p className="text-xs leading-relaxed text-label-3 sm:col-span-6">
            {L(lang, '花费按接口返回的金额累计（OpenRouter 会返回）。接口不返回金额时这个上限不起作用，只有步数限制。', 'Spend is added up from what the endpoint reports (OpenRouter does). If the endpoint reports no cost, this cap does nothing and only the step limit applies.')}
          </p>
          {error && <p className="text-sm text-bad sm:col-span-6">{error}</p>}
          <div className="flex items-center gap-3 sm:col-span-6">
            <Button disabled={saving}>{saving ? L(lang, '保存中……', 'Saving…') : L(lang, '保存', 'Save')}</Button>
            {saved && <span className="text-sm text-ok">{L(lang, '已保存', 'Saved')}</span>}
          </div>
        </form>
      </Card>
    </div>
  );
}
