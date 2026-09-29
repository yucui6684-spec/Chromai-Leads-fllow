/**
 * mailer.mjs —— nodemailer 封装（腾讯企业邮 SMTP：smtp.exmail.qq.com:465）
 *
 * 安全：
 *   - SMTP 密码优先读环境变量 SMTP_PASS，其次 config.smtp.pass
 *   - 凭据绝不打印：日志一律输出 ***
 *   - 懒加载 nodemailer：--dry / --init 场景完全不需要依赖也能跑
 */

/**
 * 取 SMTP 密码：环境变量优先
 * @param {object} smtpCfg
 * @returns {string} 密码（可能为空字符串）
 */
export function resolveSmtpPass(smtpCfg) {
  const envPass = process.env.SMTP_PASS || '';
  if (envPass) return envPass;
  const cfg = smtpCfg || {};
  return String(cfg.pass || '');
}

/** 打印用：把任意敏感串遮蔽为 *** */
export function mask(secret) {
  if (!secret) return '(empty)';
  return '***';
}

/**
 * 创建 transporter（懒加载 nodemailer）
 * @param {object} smtpCfg {host, port, secure, user, pass, from}
 * @returns {Promise<object>} nodemailer transporter
 */
export async function createTransport(smtpCfg) {
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch (e) {
    throw new Error('未安装 nodemailer，请先在 notify 目录执行 npm install（--dry/--init 不需要）');
  }
  const cfg = smtpCfg || {};
  const pass = resolveSmtpPass(cfg);
  if (!cfg.host || !cfg.user || !pass) {
    throw new Error('SMTP 配置不完整（host/user/pass）；pass 建议用环境变量 SMTP_PASS 注入');
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 465,
    secure: cfg.secure !== false,
    auth: { user: cfg.user, pass: pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
}

/**
 * 发送一封邮件
 * @param {object} transport createTransport 的返回值
 * @param {object} msg {from, to, cc, subject, text, html}
 * @returns {Promise<object>} {ok, messageId, error}
 */
export async function sendMail(transport, msg) {
  try {
    const info = await transport.sendMail({
      from: msg.from,
      to: msg.to,
      cc: (msg.cc && msg.cc.length) ? msg.cc.join(',') : undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html
    });
    return { ok: true, messageId: info && info.messageId ? info.messageId : '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 一次性发送（自行创建/关闭 transporter）。批量场景请用 createTransport + sendMail。
 * @param {object} smtpCfg
 * @param {object} msg
 * @returns {Promise<object>}
 */
export async function sendOnce(smtpCfg, msg) {
  const transport = await createTransport(smtpCfg);
  try {
    return await sendMail(transport, msg);
  } finally {
    try { transport.close(); } catch (e) { /* ignore */ }
  }
}
