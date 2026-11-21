// Sends HTML mail through Cloudflare's send_email binding. Free plan: each recipient must be a
// *verified destination address* in Email Routing (Cloudflare emails them a one-click verification link).
import { EmailMessage } from 'cloudflare:email';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export async function sendMail(binding: SendEmail, from: string, fromName: string, to: string, subject: string, html: string) {
  const domain = from.split('@')[1];
  const raw = [
    `From: ${fromName} <${from}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  await binding.send(new EmailMessage(from, to, raw));
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
