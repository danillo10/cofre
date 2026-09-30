import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./money.js";

const expenseIds = EXPENSE_CATEGORIES.map(([id]) => id);
const incomeIds = INCOME_CATEGORIES.map(([id]) => id);
const kinds = ["expense", "income", "card_payment"];

function outputText(body) {
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
}

function financialContext(state) {
  return {
    today: state.today,
    cashCents: state.cashCents,
    monthIncomeCents: state.monthIncomeCents,
    monthExpenseCents: state.monthExpenseCents,
    monthResultCents: state.monthResultCents,
    situation: state.situation?.headline,
    cards: state.cards.map((card) => ({
      name: card.name,
      balanceCents: card.balanceCents,
      limitCents: card.limitCents,
      dueDay: card.dueDay,
    })),
    budgets: state.budgets.map((budget) => ({
      category: budget.category,
      spentCents: budget.spentCents,
      limitCents: budget.limitCents,
    })),
    recentTransactions: state.transactions.slice(0, 10).map((row) => ({
      date: row.occurredOn,
      kind: row.kind,
      amountCents: row.amountCents,
      category: row.category,
      note: row.note,
    })),
  };
}

function validate(result, state) {
  if (!["transaction", "summary", "help", "chat", "unknown"].includes(result.intent)) {
    throw new Error("Intenção inválida retornada pela IA");
  }
  if (result.intent !== "transaction") return result;
  if (!kinds.includes(result.kind)) throw new Error("Tipo inválido retornado pela IA");
  if (!Number.isInteger(result.amountCents) || result.amountCents <= 0 || result.amountCents > 100_000_000) {
    throw new Error("Valor inválido retornado pela IA");
  }
  const allowed = result.kind === "income" ? incomeIds : expenseIds;
  if (result.kind !== "card_payment" && !allowed.includes(result.category)) {
    result.category = "outros";
  }
  if (result.kind === "card_payment") {
    const card = state.cards.find((item) => item.name.toLowerCase() === String(result.card ?? "").toLowerCase());
    if (!card) throw new Error("Diz qual cartão você pagou.");
    result.card = card.name;
  } else if (result.card) {
    const card = state.cards.find((item) => item.name.toLowerCase() === String(result.card).toLowerCase());
    result.card = card?.name ?? null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date ?? "")) result.date = state.today;
  result.note = String(result.note || "Lançamento pelo Telegram").trim().slice(0, 160);
  return result;
}

export function aiEnabled() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export async function understandMessage(text, state) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string", enum: ["transaction", "summary", "help", "chat", "unknown"] },
      kind: { type: ["string", "null"], enum: [...kinds, null] },
      amountCents: { type: ["integer", "null"] },
      category: { type: ["string", "null"], enum: [...new Set([...expenseIds, ...incomeIds]), null] },
      card: { type: ["string", "null"] },
      date: { type: ["string", "null"] },
      note: { type: ["string", "null"] },
      reply: { type: ["string", "null"] },
    },
    required: ["intent", "kind", "amountCents", "category", "card", "date", "note", "reply"],
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: [
        "Você é Nara, assistente financeira pessoal brasileira do Cofre.",
        "Entenda linguagem informal em português e classifique a intenção.",
        "transaction: o usuário informa uma receita, gasto ou pagamento de fatura já realizado.",
        "summary: pede saldo, resumo, situação, gastos, receitas, limites ou orçamento.",
        "help: pergunta como usar o bot. chat: conversa ou pergunta financeira que pode ser respondida com o contexto.",
        "unknown: faltam dados essenciais; em reply faça uma única pergunta objetiva.",
        "Valores são em reais, mas amountCents deve ser inteiro em centavos. 'quarenta reais' = 4000.",
        `Categorias de gasto: ${expenseIds.join(", ")}. Categorias de receita: ${incomeIds.join(", ")}.`,
        `Cartões cadastrados: ${state.cards.map((card) => card.name).join(", ") || "nenhum"}.`,
        "Use a data informada; para hoje use a data do contexto. Nunca invente valor, cartão ou transação.",
        "Para transaction, reply deve ser null. Para outras intenções, responda em português, curto e claro.",
      ].join("\n"),
      input: JSON.stringify({ message: String(text).slice(0, 4000), context: financialContext(state) }),
      text: {
        format: {
          type: "json_schema",
          name: "cofre_telegram_intent",
          strict: true,
          schema,
        },
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `OpenAI respondeu ${response.status}`);
  }
  const raw = outputText(body);
  if (!raw) throw new Error("A IA não devolveu uma interpretação");
  return validate(JSON.parse(raw), state);
}
