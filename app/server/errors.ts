/**
 * Error messages in the reader's language. The server and engine write their errors in Chinese;
 * for an English reader they are translated here, in one place, instead of at every throw site.
 *
 * The reader's language: the `lang` cookie the page sets when the reader picks one, otherwise the
 * browser's Accept-Language — the same rule the page itself uses (web/lib/i18n.ts initialLang).
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

export type Lang = 'zh' | 'en';

export function langOf(c: Context): Lang {
  const cookie = getCookie(c, 'lang');
  if (cookie === 'zh' || cookie === 'en') return cookie;
  return /^en/i.test(c.req.header('accept-language') ?? '') ? 'en' : 'zh';
}

/** Whole messages and fragments (fragments also cover composed messages such as form errors). */
const PHRASES: [string, string][] = [
  // learner sessions
  ['本站没有开放助手', 'The agent is switched off on this site'],
  ['助手还在处理上一条消息', 'The agent is still working on the previous message'],
  ['这次练习的助手用量已达上限', 'This run has used up its allowance for the agent'],
  ['助手的模型服务调用失败，请稍后再试；一直失败请联系管理员检查「助手」设置', 'The agent\'s model service failed. Please try again shortly; if it keeps failing, ask the administrator to check the Agent settings'],
  ['请填写接口地址', 'Enter the endpoint address'],
  ['请填写模型', 'Enter a model'],
  ['工作区准备失败，请稍后再试', 'The workspace could not be prepared. Please try again shortly'],
  ['题目文件暂时取不到，请稍后再试', "The case's files could not be fetched. Please try again shortly"],
  // the machines that run cases
  ['这次练习所在的沙箱机（', 'The machine this run is on ('],
  ['）现在连不上，请稍后再试', ') cannot be reached right now. Please try again shortly'],
  ['沙箱机没有回应，请稍后再试', 'The machine this run is on did not answer. Please try again shortly'],
  ['沙箱机上出了错，请稍后再试', 'Something went wrong on the machine this run is on. Please try again shortly'],
  ['沙箱机都满了，请稍后再试', 'Every sandbox machine is full. Please try again shortly'],
  ['这次练习所在的沙箱机没有装 coding agent，请联系管理员', 'The sandbox machine this run is on has no coding agent installed. Please contact the administrator'],
  ['这台沙箱机没有装 coding agent', 'This sandbox machine has no coding agent installed'],
  ['这一轮已经不在了', 'That turn is no longer there'],
  ['这里的文件是只读的，不能在原位建副本', 'These files are read-only, so a copy cannot be made beside them'],
  ['副本太多了，先清理一些', 'There are too many copies already; clear some first'],
  ['这不是一个能打开的 SQLite 数据库', 'This is not a SQLite database that can be opened'],
  ['这个数据库现在读不出来，可以在终端里用 sqlite3 查', 'This database cannot be read just now; query it with sqlite3 in the terminal'],
  ['这个文件现在不能查看', 'This file cannot be shown just now'],
  ['这次练习没有留下最初的文件，不能还原', 'This run kept no copy of the files as they were, so they cannot be put back'],
  [' 次练习还没交付。先交付或终止其中一次，再开始新的', ' runs that are not handed over. Hand one over or end it before starting another'],
  ['你已经有 ', 'You already have '],
  ['现在没有可用的沙箱机，请稍后再试', 'No sandbox machine is available right now. Please try again shortly'],
  ['这次练习在本站自己的沙箱里，而本站已不再运行沙箱', 'This run was on the site’s own sandbox, which the site no longer runs'],
  ['没有这台沙箱机', 'No such runner'],
  ['这台沙箱机还连着，先停掉它再移除', 'This runner is still connected. Stop it before removing it'],
  ['没有收到文件', 'No file was received'],
  ['导入失败', 'The import failed'],
  ['客户方环境没有启动成功，请稍后再试', "The customer's environment did not start. Please try again shortly"],
  ['路径不在工作区内', 'The path is outside the workspace'],
  ['这个文件不能修改', 'This file cannot be changed'],
  ['文件太大（上限 2 MB）', 'File too large (limit 2 MB)'],
  ['这是一个目录', 'This is a folder'],
  ['目录不存在', 'No such folder'],
  ['本站没有开放终端', 'The terminal is switched off on this site'],
  ['上一条命令还在运行', 'The previous command is still running'],
  ['命令不能为空', 'The command is empty'],
  ['这次练习已经提交', 'This run has been submitted'],
  ['这次练习已经结束', 'This run has ended'],
  ['这次练习的工作区已不存在', "This run's workspace no longer exists"],
  ['消息太长', 'The message is too long'],
  ['请填写要等多久', 'Say how long to wait'],
  ['评分被中断，请重试', 'Grading was interrupted. Please retry'],
  ['评分没有完成，请重试', 'Grading did not finish. Please retry'],
  ['缺少 to 或 question', 'Missing to or question'],
  ['缺少 command', 'Missing command'],
  ['没有这道题', 'No such case'],
  ['这道题已暂停开放，不能开始新的练习', 'This case is paused: new practice runs cannot be started'],
  ['没有这次练习', 'No such practice run'],
  ['这不是你的练习', 'This practice run is not yours'],
  ['消息不能为空', 'The message is empty'],
  ['请先开始一次练习', 'Start a practice run first'],
  ['本站需要登录后练习。登录后，你在这个浏览器里的练习记录会归到账号下', 'Please sign in to practise. Your practice runs in this browser will move to your account once you sign in'],
  ['请先登录再开始练习', 'Please sign in before starting a practice run'],
  ['缺少题目', 'Missing case'],
  ['缺少 path 或 content', 'Missing path or content'],
  ['缺少 path', 'Missing path'],
  // accounts
  ['请先登录', 'Please sign in first'],
  ['邮箱或密码不对', 'Wrong email or password'],
  ['邮箱格式不对', 'Invalid email address'],
  ['当前密码不对', 'The current password is wrong'],
  ['请填写名字', 'Please enter a name'],
  ['请填写收件邮箱', 'Please enter a recipient email address'],
  ['这个邮箱已经注册过了，请直接登录', 'This email is already registered. Please sign in'],
  ['这个邮箱已经注册过了', 'This email is already registered'],
  ['这个账号已被停用，请联系管理员', 'This account has been disabled. Please contact the administrator'],
  ['本站暂不开放注册，请联系管理员开通账号', 'Sign-up is closed. Please ask the administrator for an account'],
  ['注册方式不对', 'Invalid sign-up method'],
  ['现在注册不需要验证码', 'Sign-up does not need a verification code right now'],
  ['验证码已失效，请重新获取', 'The verification code has expired. Please request a new one'],
  ['验证码邮件发送失败，请稍后再试或联系管理员', 'Could not send the verification email. Please try again later or contact the administrator'],
  ['尝试次数太多，请稍后再试', 'Too many attempts. Please try again later'],
  ['重置链接无效或已过期，请重新申请', 'The reset link is invalid or has expired. Please request a new one'],
  ['网站还没有配置邮件服务，请联系管理员重置密码', 'Email is not set up on this site. Please ask the administrator to reset your password'],
  ['还没有配置邮件服务，请联系管理员', 'Email is not set up yet. Please contact the administrator'],
  ['服务器没有配置 FDEGYM_PUBLIC_URL，无法发送重置邮件', 'The server has no FDEGYM_PUBLIC_URL, so reset emails cannot be sent'],
  ['没有这个用户', 'No such user'],
  // admin
  ['需要管理员权限', 'Administrator access required'],
  ['至少要保留一个管理员', 'At least one administrator must remain'],
  ['不能停用自己或取消自己的管理员身份', 'You cannot disable yourself or remove your own administrator role'],
  ['角色不对', 'Invalid role'],
  ['状态不对', 'Invalid status'],
  ['hidden 必须是 true 或 false', 'hidden must be true or false'],
  ['需要先在「邮件服务」里配置好发信，才能要求邮箱验证', 'Set up sending in “Email” before requiring email verification'],
].sort((a, b) => b[0].length - a[0].length) as [string, string][];

/** Messages with values in them. */
const PATTERNS: [RegExp, (...m: string[]) => string][] = [
  [/文件不存在：(.+)/, (p) => `File not found: ${p}`],
  [/验证码刚发过，请 (\d+) 秒后再试/, (n) => `A code was just sent. Please try again in ${n} seconds`],
  [/发送失败：(.+)/, (m) => `Sending failed: ${m}`],
];

const CJK = /[㐀-鿿＀-￯]/;

const GENERIC = {
  zh: '服务器出错了，请稍后再试。',
  en: 'Something went wrong on the server. Please try again.',
};

/** The message to show for an error. Model failures are logged in full and shown in plain words. */
export function errorText(e: unknown, lang: Lang): string {
  return translate(e instanceof Error ? e.message : String(e), lang);
}

/** `fallback`: the English to show when a Chinese message has no translation (default: a generic one). */
export function translate(message: string, lang: Lang, fallback = GENERIC.en): string {
  if (lang === 'zh' || !CJK.test(message)) return message;
  for (const [re, f] of PATTERNS) {
    const m = re.exec(message);
    if (m) return f(...m.slice(1));
  }
  let out = message;
  for (const [zh, en] of PHRASES) out = out.split(zh).join(en);
  out = out.replace(/：/g, ': ').replace(/；/g, '; ');
  return CJK.test(out) ? fallback : out;
}
