/**
 * Outgoing mail (password resets), over SMTP configured in the admin pages. The SMTP password is
 * stored encrypted and never sent back to the browser.
 */
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { decrypt, encrypt, getSetting, putSetting } from './accounts';

interface Stored { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }

export const MailInput = z.object({
  host: z.string().trim().min(1, '请填写 SMTP 服务器').max(200),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(200).optional(),
  /** Absent keeps the stored password, "" removes it. */
  pass: z.string().max(500).optional(),
  from: z.string().trim().min(3, '请填写发件人').max(200),
});

const KEY = 'mail';
const load = () => getSetting<Stored>(KEY);

export async function mailView() {
  const s = await load();
  return s ? { host: s.host, port: s.port, secure: s.secure, user: s.user, from: s.from, hasPass: !!s.pass, configured: true } : { configured: false };
}

export async function saveMail(input: z.infer<typeof MailInput>) {
  const old = await load();
  const pass = input.pass === undefined ? old?.pass : input.pass === '' ? undefined : encrypt(input.pass);
  await putSetting(KEY, { host: input.host, port: input.port, secure: input.secure, user: input.user || undefined, pass, from: input.from } satisfies Stored);
}

export const mailConfigured = async () => !!(await load());

export async function sendMail(to: string, subject: string, text: string) {
  const s = await load();
  if (!s) throw new Error('还没有配置邮件服务，请联系管理员');
  const transport = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass ? decrypt(s.pass) : '' } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  await transport.sendMail({ from: s.from, to, subject, text });
}
