import { addDays, daysBetween, formatBRL, monthBounds } from "./money.js";

function mondayOf(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  return addDays(iso, 1 - weekday);
}

function spentBetween(transactions, start, end) {
  return transactions.reduce((total, row) => {
    if (row.kind !== "expense") return total;
    if (row.occurred_on < start || row.occurred_on > end) return total;
    return total + row.amount_cents;
  }, 0);
}

function band(score) {
  if (score >= 70) return { word: "Controlado", tone: "ok" };
  if (score >= 45) return { word: "Apertando", tone: "warn" };
  return { word: "Ruim", tone: "bad" };
}

function budgetFactor(budgetViews) {
  if (budgetViews.length === 0) {
    return { id: "tetos", label: "Tetos", score: 70, word: "Sem teto", tone: "warn", detail: "Defina um teto para eu medir se a categoria está folgada." };
  }
  const scores = budgetViews.map((budget) => {
    if (budget.ratio <= 0.8) return 100 - budget.ratio * 25;
    if (budget.ratio <= 1) return 80 - (budget.ratio - 0.8) * 200;
    return Math.max(0, 40 - (budget.ratio - 1) * 90);
  });
  const score = Math.round(scores.reduce((sum, item) => sum + item, 0) / scores.length);
  const worst = budgetViews.slice().sort((a, b) => b.ratio - a.ratio)[0];
  const status = band(score);
  const detail = worst.ratio >= 1
    ? `${worst.label} estourou o teto: ${formatBRL(worst.spentCents)} de ${formatBRL(worst.limitCents)}.`
    : worst.ratio >= 0.8
      ? `${worst.label} já usou ${Math.round(worst.ratio * 100)}% do teto.`
      : "Os tetos ainda têm folga.";
  return { id: "tetos", label: "Tetos", score, word: status.word, tone: status.tone, detail };
}

function creditFactor(cardViews) {
  if (cardViews.length === 0) {
    return { id: "credito", label: "Crédito", score: 80, word: "Sem cartão", tone: "ok", detail: "Nenhum cartão cadastrado." };
  }
  const worst = cardViews.slice().sort((a, b) => b.ratio - a.ratio)[0];
  const score = Math.max(0, Math.round(100 - worst.ratio * 100));
  const status = band(score);
  const detail = worst.ratio >= 0.7
    ? `${worst.name} está em ${Math.round(worst.ratio * 100)}% do limite.`
    : worst.ratio >= 0.3
      ? `${worst.name} já comprometeu ${Math.round(worst.ratio * 100)}% do limite.`
      : "O crédito está folgado.";
  return { id: "credito", label: "Crédito", score, word: status.word, tone: status.tone, detail };
}

function paceFactor({ today, monthIncome, monthExpense, budgetViews }) {
  const { start, end } = monthBounds(today);
  const progress = (daysBetween(start, today) + 1) / (daysBetween(start, end) + 1);
  let pace = null;
  let detail = "Lance uma receita ou um teto para eu medir o ritmo.";
  if (monthIncome > 0) {
    pace = monthExpense / monthIncome / progress;
    detail = monthExpense <= monthIncome
      ? `Entrou ${formatBRL(monthIncome)} e saiu ${formatBRL(monthExpense)}.`
      : `Os gastos passaram da receita em ${formatBRL(monthExpense - monthIncome)}.`;
  } else if (budgetViews.length > 0) {
    const limit = budgetViews.reduce((sum, budget) => sum + budget.limitCents, 0);
    const spent = budgetViews.reduce((sum, budget) => sum + budget.spentCents, 0);
    pace = limit > 0 ? spent / limit / progress : null;
    detail = `Os tetos somam ${formatBRL(limit)} e já foram ${formatBRL(spent)}.`;
  }
  let score = 60;
  if (pace !== null) {
    if (pace <= 0.85) score = 92;
    else if (pace <= 1) score = 74;
    else if (pace <= 1.2) score = 48;
    else score = 22;
  }
  const status = band(score);
  return { id: "ritmo", label: "Ritmo", score, word: status.word, tone: status.tone, detail };
}

export function buildSituation({ today, monthIncome, monthExpense, budgetViews, cardViews, transactions }) {
  const factors = [
    budgetFactor(budgetViews),
    creditFactor(cardViews),
    paceFactor({ today, monthIncome, monthExpense, budgetViews }),
  ];
  const worst = factors.slice().sort((a, b) => a.score - b.score)[0];
  const score = worst.score;

  const recent = spentBetween(transactions, addDays(today, -6), today);
  const prior = spentBetween(transactions, addDays(today, -13), addDays(today, -7));
  let trend = "estavel";
  if (prior > 0 && recent > prior * 1.15) trend = "piorando";
  else if (prior > 0 && recent < prior * 0.85) trend = "melhorando";

  let tone = worst.tone;
  let headline = worst.score >= 70 ? "Sob controle" : worst.score >= 45 ? "Apertando" : "Fora de controle";
  if (trend === "piorando" && worst.score >= 45) {
    headline = "Piorando";
    tone = worst.score < 45 ? "bad" : "warn";
  }
  if (worst.score < 45) {
    headline = "Fora de controle";
    tone = "bad";
  }

  const hasMovement = transactions.some((row) => row.kind === "expense" || row.kind === "income");
  if (!hasMovement) {
    headline = "Sem lançamentos";
    tone = "ok";
  }

  const trendText = {
    piorando: `Os últimos 7 dias gastaram ${formatBRL(recent)}, acima dos ${formatBRL(prior)} da semana anterior.`,
    melhorando: `Os últimos 7 dias gastaram ${formatBRL(recent)}, abaixo dos ${formatBRL(prior)} da semana anterior.`,
    estavel: prior === 0
      ? "A semana anterior não teve gastos para comparar."
      : `A semana está parecida: ${formatBRL(recent)} agora, ${formatBRL(prior)} antes.`,
  }[trend];

  const summary = hasMovement
    ? `${worst.detail} ${trendText}`
    : "Manda um gasto em texto ou uma foto do cupom no Telegram para eu começar a medir.";

  const monday = mondayOf(today);
  const weeks = [];
  for (let index = 3; index >= 0; index -= 1) {
    const start = addDays(monday, -7 * index);
    const end = addDays(start, 6);
    weeks.push({
      label: `${start.slice(8)}/${start.slice(5, 7)}`,
      cents: spentBetween(transactions, start, end),
    });
  }

  return {
    score,
    headline,
    tone,
    trend,
    summary,
    recentCents: recent,
    priorCents: prior,
    factors,
    weeks,
  };
}

export function formatSituationMessage(situation) {
  const bar = (score) => {
    const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
    return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  };
  const lines = [
    `${situation.headline} · ${situation.score}/100`,
    situation.summary,
    "",
    ...situation.factors.map((factor) => `${factor.label.padEnd(8, " ")} ${bar(factor.score)} ${factor.word}`),
  ];
  return lines.join("\n");
}
