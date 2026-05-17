// 邮件发送工具：默认走 Resend；未配置 RESEND_API_KEY 时退化到 console.log，
// 这样 dev 期可以直接从后端控制台拷贝验证链接走通流程。
//
// 设计要点：
// - 所有 send* 函数都 try/catch 内部，邮件发送失败不会让注册 / 重置请求 500；
//   失败时返回 { ok: false, reason } 让上层决定是否回滚或重试。
// - 对外只暴露语义化函数（sendVerificationEmail / sendPasswordResetEmail），
//   模板内容收敛在这里，不让路由处理函数关心 HTML。

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || 'Metro Designer <onboarding@resend.dev>').trim();
// 邮件正文里的链接需要前端 URL；部署时设置成 Vercel 前端域名。
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
  .split(',')[0]
  .trim()
  .replace(/\/$/, '');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// dev 兜底：把邮件内容打到后端控制台
function logToConsole(label, to, subject, html, text) {
  console.log('────────────────────────────────────────────────────────');
  console.log(`[email:${label}] to=${to}`);
  console.log(`[email:${label}] subject=${subject}`);
  console.log(`[email:${label}] text:\n${text}`);
  if (process.env.EMAIL_DEBUG_HTML === '1') {
    console.log(`[email:${label}] html:\n${html}`);
  }
  console.log('────────────────────────────────────────────────────────');
}

async function sendViaResend({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    return { ok: false, reason: 'no_key' };
  }
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        html,
        text
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[email] Resend rejected ${response.status} ${body.slice(0, 300)}`);
      return { ok: false, reason: `resend_${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] Resend network error', err);
    return { ok: false, reason: 'network' };
  }
}

function escape(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function brandedShell(title, body) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:14px;padding:32px 32px 28px;box-shadow:0 8px 24px rgba(15,23,42,.06)">
    <div style="font-size:14px;letter-spacing:.04em;color:#2563eb;font-weight:700;margin-bottom:18px">METRO DESIGNER</div>
    <h1 style="font-size:20px;line-height:1.35;color:#0f172a;margin:0 0 16px">${escape(title)}</h1>
    ${body}
    <div style="margin-top:28px;padding-top:18px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.6">
      如果不是你本人操作，请忽略此邮件，密码不会变化。<br/>
      链接将在 15 分钟后失效。
    </div>
  </div>
</body></html>`;
}

async function sendVerificationEmail({ to, username, token }) {
  const link = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = '验证你的 Metro Designer 邮箱';
  const text = [
    `你好 ${username || '设计师'}，`,
    '',
    '请点击下方链接完成邮箱验证（15 分钟内有效）：',
    link,
    '',
    '如果不是你本人操作，请忽略此邮件。'
  ].join('\n');
  const html = brandedShell(
    '验证你的邮箱',
    `<p style="font-size:15px;color:#334155;line-height:1.65;margin:0 0 18px">
      你好 <strong>${escape(username || '设计师')}</strong>，欢迎加入 Metro Designer。点击下方按钮完成邮箱验证：
    </p>
    <p style="margin:0 0 18px">
      <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:15px">完成验证</a>
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0;word-break:break-all">
      如果按钮无法点击，请复制以下链接到浏览器：<br/>${link}
    </p>`
  );

  const viaResend = await sendViaResend({ to, subject, html, text });
  if (viaResend.ok) return viaResend;
  // Resend 未配置或失败 → 走 console 兜底，不阻塞业务
  logToConsole('verify', to, subject, html, text);
  return { ok: true, fallback: 'console' };
}

async function sendPasswordResetEmail({ to, username, token }) {
  const link = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const subject = '重置你的 Metro Designer 密码';
  const text = [
    `你好 ${username || '设计师'}，`,
    '',
    '你刚刚发起了密码重置请求，请点击下方链接完成（15 分钟内有效）：',
    link,
    '',
    '如果不是你本人操作，请忽略此邮件。'
  ].join('\n');
  const html = brandedShell(
    '重置你的密码',
    `<p style="font-size:15px;color:#334155;line-height:1.65;margin:0 0 18px">
      你好 <strong>${escape(username || '设计师')}</strong>，我们收到了重置 Metro Designer 密码的请求。点击下方按钮设置新密码：
    </p>
    <p style="margin:0 0 18px">
      <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:15px">设置新密码</a>
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0;word-break:break-all">
      如果按钮无法点击，请复制以下链接到浏览器：<br/>${link}
    </p>`
  );

  const viaResend = await sendViaResend({ to, subject, html, text });
  if (viaResend.ok) return viaResend;
  logToConsole('reset', to, subject, html, text);
  return { ok: true, fallback: 'console' };
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  // 暴露这些常量给 server/index.js 用来做配置自检
  APP_BASE_URL,
  EMAIL_FROM,
  hasResendKey: () => Boolean(RESEND_API_KEY)
};
