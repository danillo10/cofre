export function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

export function telegramConfig(cofre) {
  const token = botToken();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || (cofre ? cofre.setting("telegram_chat") : "");
  if (!token || !chatId) return null;
  return { token, chatId };
}

export function inAlertWindow() {
  const hourMinute = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  return hourMinute >= "08:00" && hourMinute < "22:00";
}

export function formatAlertMessage(alerts) {
  const lines = ["Cofre"];
  for (const alert of alerts) {
    lines.push("", `${alert.agent} · ${alert.title}`, alert.body);
  }
  return lines.join("\n");
}

export async function sendTelegram(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.description || "Falha ao enviar mensagem no Telegram");
  }
}

export async function deliverAlerts(cofre) {
  const telegram = telegramConfig(cofre);
  const pending = cofre.pendingAlerts();
  if (pending.length === 0) {
    return { sent: 0, reason: cofre.isDemo() ? "demo" : "quiet" };
  }
  if (!telegram) return { sent: 0, reason: "unconfigured", pending };
  if (!inAlertWindow()) return { sent: 0, reason: "quiet-hours", pending };
  const text = formatAlertMessage(pending);
  await sendTelegram(telegram.token, telegram.chatId, text);
  cofre.markSent(pending.map((alert) => alert.fingerprint));
  return { sent: pending.length };
}
