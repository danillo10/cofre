import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cofre } from "./engine.js";
import { launchParsed, launchText } from "./inbox.js";
import { parseLaunch } from "./parse.js";
import { daysBetween, formatBRL, nextDueDate, toCents } from "./money.js";

const dbPath = path.join(os.tmpdir(), `cofre-check-${process.pid}.sqlite`);
process.env.COFRE_DB = dbPath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  assert(toCents("1.234,56") === 123456, "milhar brasileiro");
  assert(toCents("42,90") === 4290, "vírgula");
  assert(toCents(42.9) === 4290, "número");
  assert(toCents("R$ 10") === 1000, "prefixo");
  const lunch = parseLaunch("42,90 almoço");
  assert(lunch.amountCents === 4290 && lunch.category === "alimentacao" && lunch.kind === "expense", "texto do almoço");
  const market = parseLaunch("gastei R$ 1.234,56 no mercado");
  assert(market.amountCents === 123456 && market.category === "mercado", "milhar");
  const salary = parseLaunch("recebi 5200 de salário");
  assert(salary.kind === "income" && salary.category === "salario" && salary.amountCents === 520000, "salário");
  const payment = parseLaunch("paguei 200 no Nubank", { cards: ["Nubank"] });
  assert(payment.kind === "card_payment" && payment.card === "Nubank" && payment.amountCents === 20000, "pagamento");
  const receipt = parseLaunch("PADARIA\n10/09/2026\nPao 5,00\nCafe 7,50\nTOTAL R$ 12,50");
  assert(receipt.amountCents === 1250 && receipt.category === "alimentacao", "total do cupom");
  assert(parseLaunch("oi") === null, "texto sem valor");
  let rejected = false;
  try {
    toCents("-5");
  } catch {
    rejected = true;
  }
  assert(rejected, "recusa valor negativo");

  const cofre = new Cofre(dbPath);
  cofre.seedDemo();
  const demo = cofre.snapshot();
  assert(demo.demo, "exemplo marcado");
  assert(demo.pendingAlerts === undefined, "snapshot não vaza pending solto");
  assert(demo.alerts.every((alert) => alert.pending === false), "exemplo não dispara Telegram");
  assert(demo.alerts.some((alert) => alert.agent === "Nara" && alert.level === "critico"), "teto estourado");
  assert(demo.alerts.some((alert) => alert.agent === "Vigia" && alert.fingerprint.includes("credit")), "crédito alto");
  assert(demo.alerts.some((alert) => alert.fingerprint.startsWith("due:")), "vencimento próximo");
  assert(demo.game.xp > 0 && demo.game.level >= 1, "gamificação");
  assert(demo.game.streak >= 3, `sequência curta: ${demo.game.streak}`);
  assert(demo.situation.factors.length === 3, "três fatores da situação");
  assert(demo.situation.weeks.length === 4, "quatro semanas");
  assert(demo.situation.tone === "bad" || demo.situation.headline === "Fora de controle" || demo.situation.headline === "Piorando", `situação do exemplo: ${demo.situation.headline}`);
  assert(demo.agents.length === 3, "três agentes");
  const blockedLaunch = launchText(cofre, "12,50 padaria");
  assert(blockedLaunch.code === "DEMO", "exemplo pede confirmação");
  const nubank = demo.cards.find((card) => card.name === "Nubank");
  assert(nubank.ratio >= 0.7, `uso do limite baixo: ${nubank.ratio}`);
  assert(nubank.daysUntilDue >= 0 && nubank.daysUntilDue <= 3, "vencimento do exemplo");
  assert(daysBetween(demo.today, nextDueDate(demo.today, nubank.dueDay)) === nubank.daysUntilDue, "cálculo do vencimento");

  cofre.reset();
  assert(!cofre.isDemo() && cofre.isEmpty(), "reset limpa");
  const cardId = cofre.addCard({ name: "Nubank", limit: "1000", closeDay: 3, dueDay: 10 });
  cofre.setBudget("alimentacao", "100");
  cofre.addTransaction({ kind: "expense", amount: "80,00", category: "alimentacao", card: cardId, note: "almoço" });
  let mid = cofre.snapshot();
  assert(mid.alerts.some((alert) => alert.level === "atencao"), "80% avisa");
  assert(mid.alerts.filter((alert) => alert.pending).length > 0, "alerta real fica pendente");
  cofre.addTransaction({ kind: "expense", amount: 30, category: "alimentacao", card: "Nubank" });
  mid = cofre.snapshot();
  assert(mid.cards[0].balanceCents === 11000, "fatura soma gastos");
  assert(mid.alerts.some((alert) => alert.title.includes("estourou")), "estouro");
  let blocked = false;
  try {
    cofre.addTransaction({ kind: "card_payment", amount: 200, card: "Nubank" });
  } catch {
    blocked = true;
  }
  assert(blocked, "pagamento maior que a fatura");
  cofre.addTransaction({ kind: "card_payment", amount: "50", card: "nubank" });
  mid = cofre.snapshot();
  assert(mid.cards[0].balanceCents === 6000, "pagamento abate fatura");
  assert(mid.game.badges.some((badge) => badge.id === "pagador" && badge.earned), "selo pagador");

  const pending = cofre.pendingAlerts().map((alert) => alert.fingerprint);
  cofre.markSent(pending);
  const after = cofre.snapshot();
  assert(after.alerts.filter((alert) => alert.pending && alert.level !== "critico").length === 0, "ack tira a fila");
  const launched = launchText(cofre, "15,00 café");
  assert(launched.ok, launched.error || "lançamento por texto");
  assert(launched.state.transactions.some((row) => row.source === "telegram" && row.amountCents === 1500), "origem telegram");
  assert(launched.reply.includes(launched.state.situation.headline), "resposta traz a situação");
  assert(launched.reply.includes("Teto de Alimentação"), "resposta atualiza o uso do teto");
  const parcelled = launchParsed(cofre, {
    intent: "transaction",
    kind: "expense",
    amountCents: 10000,
    category: "outros",
    card: null,
    date: cofre.today(),
    note: "Compra parcelada",
    installmentCount: 3,
  }, { rawText: "compra de 100 em 3 vezes" });
  assert(parcelled.ok, parcelled.error || "lançamento parcelado");
  const parts = parcelled.state.transactions.filter((row) => row.note.startsWith("Compra parcelada · parcela"));
  assert(parts.length === 3, "cria todas as parcelas");
  assert(parts.reduce((sum, row) => sum + row.amountCents, 0) === 10000, "parcelas preservam o total");
  assert(parts.some((row) => row.note.endsWith("3/3")), "numera parcelas");

  console.log(`ok · exemplo em ${formatBRL(demo.monthExpenseCents)} de gastos e nível ${demo.game.level}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}
