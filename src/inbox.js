import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { understandMessage } from "./ai.js";
import { categoryLabel, formatBRL } from "./money.js";
import { parseLaunch } from "./parse.js";
import { formatSituationMessage } from "./situation.js";
import { botToken, sendTelegram, telegramConfig } from "./telegram.js";

const HELP = [
  "Manda um gasto em texto ou uma foto do cupom.",
  "42,90 almoço",
  "gastei 80 no mercado",
  "recebi 5200 de salário",
  "paguei 200 no Nubank",
  "defina um teto de 600 para alimentação",
  "",
  "Pode escrever naturalmente: a IA entende frases como “ontem gastei quarenta reais no almoço”.",
  "Na foto, a IA lê o total, a data e as parcelas. Se ficar ilegível, escreve o valor na legenda.",
  "/resumo mostra se a situação está sob controle ou piorando.",
].join("\n");

export function launchText(cofre, text, { note, rawText } = {}) {
  const cards = cofre.snapshot().cards.map((card) => card.name);
  const parsed = parseLaunch(text, { cards });
  if (!parsed || parsed.command) {
    return { ok: false, error: "Não achei um valor. Exemplo: 42,90 almoço." };
  }
  if (parsed.error) return { ok: false, error: parsed.error };
  return launchParsed(cofre, parsed, { note, rawText: rawText || text });
}

export function launchParsed(cofre, parsed, { note, rawText = "" } = {}) {
  const installments = splitInstallments(parsed);
  try {
    for (const installment of installments) {
      cofre.addTransaction({
        kind: parsed.kind,
        amountCents: installment.amountCents,
        category: parsed.category,
        card: parsed.card,
        note: installment.note,
        date: installment.date,
        source: "telegram",
        rawText,
      });
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const state = cofre.snapshot();
  return { ok: true, parsed, reply: formatLaunchReply(parsed, state, installments), state };
}

function addMonths(iso, offset) {
  const [year, month, day] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + offset, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return [
    target.getUTCFullYear(),
    String(target.getUTCMonth() + 1).padStart(2, "0"),
    String(Math.min(day, lastDay)).padStart(2, "0"),
  ].join("-");
}

function splitInstallments(parsed) {
  const count = parsed.kind === "expense" && Number.isInteger(parsed.installmentCount)
    ? Math.max(1, Math.min(60, parsed.installmentCount))
    : 1;
  const base = Math.floor(parsed.amountCents / count);
  const remainder = parsed.amountCents % count;
  const firstDate = parsed.date;
  const label = parsed.note || "Compra";
  return Array.from({ length: count }, (_, index) => ({
    amountCents: base + (index < remainder ? 1 : 0),
    date: firstDate ? addMonths(firstDate, index) : undefined,
    note: count > 1 ? `${label} · parcela ${index + 1}/${count}`.slice(0, 160) : label,
  }));
}

function formatLaunchReply(parsed, state, installments) {
  const label = parsed.kind === "card_payment"
    ? "Pagamento"
    : categoryLabel(parsed.kind, parsed.category);
  const where = parsed.card ? ` no ${parsed.card}` : "";
  const launch = installments.length > 1
    ? `Nara registrou ${installments.length} parcelas de ${formatBRL(parsed.amountCents)} no total em ${label}${where}.`
    : `Nara lançou ${formatBRL(parsed.amountCents)} em ${label}${where}.`;
  const budget = parsed.kind === "expense"
    ? state.budgets.find((item) => item.category === parsed.category)
    : null;
  const budgetLine = budget
    ? `Teto de ${budget.label}: ${formatBRL(budget.spentCents)} de ${formatBRL(budget.limitCents)} (${Math.round(budget.ratio * 100)}%).`
    : null;
  return [launch, budgetLine, "", formatSituationMessage(state.situation)].filter((line) => line !== null).join("\n");
}

function formatBudgetReply(state, category) {
  const budget = state.budgets.find((item) => item.category === category);
  const remaining = Math.max(0, budget.limitCents - budget.spentCents);
  const status = budget.ratio >= 1
    ? `O teto já foi ultrapassado em ${formatBRL(budget.spentCents - budget.limitCents)}.`
    : `Ainda cabem ${formatBRL(remaining)} neste mês.`;
  return [
    `Teto de ${budget.label} atualizado para ${formatBRL(budget.limitCents)}.`,
    `Usado: ${formatBRL(budget.spentCents)} (${Math.round(budget.ratio * 100)}%). ${status}`,
    "",
    formatSituationMessage(state.situation),
  ].join("\n");
}

async function readImageText(buffer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cofre-"));
  const file = path.join(dir, "cupom");
  try {
    await writeFile(file, buffer);
    for (const lang of ["por+eng", "por", "eng", null]) {
      const text = await runTesseract(file, lang);
      if (text.trim()) return text;
    }
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runTesseract(file, lang) {
  const args = lang ? [file, "stdout", "-l", lang] : [file, "stdout"];
  return new Promise((resolve) => {
    const child = spawn("tesseract", args, { timeout: 20000 });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
  });
}

async function downloadPhoto(token, fileId) {
  const meta = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`).then((response) => response.json());
  if (!meta.ok) throw new Error(meta.description || "Não consegui baixar a foto");
  const file = await fetch(`https://api.telegram.org/file/bot${token}/${meta.result.file_path}`);
  if (!file.ok) throw new Error("Não consegui baixar a foto");
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > 15 * 1024 * 1024) throw new Error("A imagem passou de 15 MB");
  const receivedType = file.headers.get("content-type") || "";
  const extension = path.extname(meta.result.file_path || "").toLowerCase();
  const inferredType = {
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  }[extension];
  const mime = receivedType.startsWith("image/") ? receivedType : inferredType || "image/jpeg";
  return { buffer, mime };
}

function allowedChat(cofre, chatId) {
  const configured = process.env.TELEGRAM_CHAT_ID?.trim();
  if (configured) return configured === String(chatId);
  const known = cofre.setting("telegram_chat");
  if (!known) {
    cofre.putSetting("telegram_chat", String(chatId));
    return true;
  }
  return known === String(chatId);
}

async function replyTo(token, chatId, text) {
  await sendTelegram(token, chatId, text);
}

export async function handleMessage(cofre, message, token) {
  const chatId = String(message.chat.id);
  if (!allowedChat(cofre, chatId)) {
    await replyTo(token, chatId, "Este Cofre já está ligado a outra conversa.");
    return;
  }

  const caption = message.caption?.trim() || "";
  let text = message.text?.trim() || caption;
  let image = null;
  if (message.photo?.length) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    image = await downloadPhoto(token, fileId);
    const ocr = await readImageText(image.buffer);
    text = [caption, ocr].filter(Boolean).join("\n");
  }
  if (!text && !image) {
    await replyTo(token, chatId, "Não consegui ler essa mensagem.\n\n" + HELP);
    return;
  }

  const folded = text.trim().toLowerCase();
  const command = folded.replace("/", "");
  if (command === "start") {
    await replyTo(token, chatId, HELP);
    return;
  }
  if (command === "resumo") {
    await replyTo(token, chatId, formatSituationMessage(cofre.snapshot().situation));
    return;
  }
  let interpreted = null;
  try {
    interpreted = await understandMessage(text, cofre.snapshot(), { image });
  } catch (error) {
    console.error(`Telegram IA: ${error.message}`);
  }

  if (interpreted?.intent === "budget") {
    try {
      cofre.setBudget(interpreted.category, interpreted.amountCents / 100);
      const state = cofre.snapshot();
      await replyTo(token, chatId, formatBudgetReply(state, interpreted.category));
    } catch (error) {
      await replyTo(token, chatId, error.message);
    }
    return;
  }

  if (interpreted && interpreted.intent !== "transaction") {
    const answer = interpreted.intent === "summary"
      ? interpreted.reply || formatSituationMessage(cofre.snapshot().situation)
      : interpreted.reply || HELP;
    await replyTo(token, chatId, answer);
    return;
  }

  const result = interpreted
    ? launchParsed(cofre, interpreted, { note: caption || interpreted.note, rawText: text })
    : launchText(cofre, text, { note: caption || undefined, rawText: text });
  await replyTo(token, chatId, result.ok ? result.reply : result.error);
}

async function getUpdates(token, offset) {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message"] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.description || "Falha ao ler o Telegram");
  }
  return body.result ?? [];
}

export function startInbox(cofre) {
  const token = botToken();
  if (!token) return;
  poll(cofre, token);
}

async function poll(cofre, token) {
  let offset = Number(cofre.setting("telegram_offset") || 0);
  while (true) {
    try {
      const updates = await getUpdates(token, offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (!cofre.claimUpdate(update.update_id)) continue;
        const message = update.message;
        if (!message || message.chat?.type !== "private") continue;
        try {
          await handleMessage(cofre, message, token);
        } catch (error) {
          console.error(`Telegram: ${error.message}`);
          try {
            await replyTo(token, String(message.chat.id), "Não consegui lançar esta mensagem. Tenta de novo com o valor escrito, por exemplo: 42,90 almoço.");
          } catch {
            // a resposta pode falhar se o token estiver inválido
          }
        }
      }
      cofre.putSetting("telegram_offset", String(offset));
    } catch (error) {
      console.error(`Telegram: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }
}

export function inboxStatus(cofre) {
  const token = Boolean(botToken());
  const chat = Boolean(telegramConfig(cofre));
  return { listening: token, chatReady: chat };
}
