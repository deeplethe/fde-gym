/**
 * Who may create an account: anyone (open), anyone who proves the address with an e-mailed code
 * (email), or nobody, in which case admins create members (closed). A site with no accounts yet
 * always lets the first person sign up, so a fresh deployment can't lock itself out.
 *
 * Also here: whether people may practise without an account (anonymous runs kept in the browser).
 */
import { countUsers, getSetting, putSetting } from './accounts';
import { mailConfigured } from './mail';

export type RegistrationMode = 'open' | 'email' | 'closed';
export const REGISTRATION_MODES: RegistrationMode[] = ['open', 'email', 'closed'];

interface Stored { mode: RegistrationMode; closedMessage?: string }
const load = () => getSetting<Stored>('registration');

export async function registrationMode(): Promise<RegistrationMode> {
  const m = (await load())?.mode;
  return m && REGISTRATION_MODES.includes(m) ? m : 'open';
}

/** Change the mode and/or the note shown while sign-up is closed (e.g. whom to contact). */
export async function setRegistration(change: { mode?: RegistrationMode; closedMessage?: string }) {
  const mode = change.mode ?? await registrationMode();
  if (!REGISTRATION_MODES.includes(mode)) throw new Error('注册方式不对');
  if (change.mode === 'email' && !(await mailConfigured())) throw new Error('需要先在「邮件服务」里配置好发信，才能要求邮箱验证');
  const closedMessage = (change.closedMessage ?? (await load())?.closedMessage ?? '').trim().slice(0, 500);
  await putSetting('registration', { mode, ...(closedMessage ? { closedMessage } : {}) } satisfies Stored);
}

/** What the sign-up page needs to know. `bootstrap`: no accounts yet, so the first one may always register. */
export async function registrationInfo() {
  const bootstrap = (await countUsers()) === 0;
  const stored = await load();
  const mode = stored?.mode && REGISTRATION_MODES.includes(stored.mode) ? stored.mode : 'open';
  return { mode: bootstrap ? 'open' as const : mode, bootstrap, configured: mode, closedMessage: stored?.closedMessage ?? '' };
}

/** Whether practice without signing in is allowed (default yes). */
export async function allowAnonymous(): Promise<boolean> {
  return (await getSetting<{ allowAnonymous: boolean }>('practice'))?.allowAnonymous ?? true;
}

export async function setAllowAnonymous(allow: boolean) {
  await putSetting('practice', { allowAnonymous: allow });
}
