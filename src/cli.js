import { Cofre, loadEnv } from "./engine.js";
import { formatBRL } from "./money.js";
import { deliverAlerts, formatAlertMessage } from "./telegram.js";

loadEnv();
const cofre = new Cofre();
const command = process.argv[2];
const json = process.argv.includes("--json");

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function print(data) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function fail(error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}

function takeOverFromDemo() {
  if (cofre.isDemo()) cofre.reset();
}

function help() {
  console.log(`Cofre — finanças no OpenClaw

  state                         resumo completo em JSON
  summary                       caixa, mês e agentes
  alerts                        alertas ativos
  pending                       alertas ainda não enviados
  ack <fingerprint...>          marca alertas como enviados
  add expense <valor> <categoria> [--card nome] [--note texto] [--date AAAA-MM-DD]
  add income <valor> <categoria> [--note texto] [--date AAAA-MM-DD]
  add payment <valor> <cartão> [--note texto] [--date AAAA-MM-DD]
  card add <nome> --limit <valor> --close <dia> --due <dia>
  budget set <categoria> <valor>
  reset --yes                   apaga todos os dados
  watch                         envia alertas novos ao Telegram

Categorias de gasto: alimentacao, mercado, transporte, moradia, lazer, saude, assinaturas, educacao, outros
Categorias de receita: salario, freelance, outros`);
}

try {
  if (!command || command === "help" || command === "--help") {
    help();
  } else if (command === "state") {
    print(cofre.snapshot());
  } else if (command === "summary") {
    const state = cofre.snapshot();
    if (json) {
      print({
        cashCents: state.cashCents,
        monthIncomeCents: state.monthIncomeCents,
        monthExpenseCents: state.monthExpenseCents,
        monthResultCents: state.monthResultCents,
        agents: state.agents,
        game: state.game,
        challenge: state.challenge,
      });
    } else {
      const sign = state.monthResultCents >= 0 ? "no azul" : "no vermelho";
      console.log(
        [
          "Seus números.",
          `Caixa ${formatBRL(state.cashCents)}`,
          `Mês: entrou ${formatBRL(state.monthIncomeCents)}, saiu ${formatBRL(state.monthExpenseCents)} (${sign}).`,
          ...state.agents.map((agent) => `${agent.name}: ${agent.line}`),
        ].join("\n"),
      );
    }
  } else if (command === "alerts" || command === "pending") {
    const state = cofre.snapshot();
    const alerts = command === "pending" ? state.alerts.filter((alert) => alert.pending) : state.alerts;
    if (json) print(alerts);
    else if (alerts.length === 0) console.log(command === "pending" ? "Nada novo para avisar." : "Nenhum alerta ativo.");
    else console.log(formatAlertMessage(alerts));
  } else if (command === "ack") {
    const fingerprints = process.argv.slice(3).filter((item) => !item.startsWith("--"));
    if (fingerprints.length === 0) throw new Error("Informe ao menos um fingerprint");
    cofre.markSent(fingerprints);
    console.log(`Marquei ${fingerprints.length} alerta(s) como enviado(s).`);
  } else if (command === "add") {
    takeOverFromDemo();
    const kind = process.argv[3];
    const amount = process.argv[4];
    const extra = process.argv[5];
    const mapped = kind === "payment" ? "card_payment" : kind;
    const id = cofre.addTransaction({
      kind: mapped,
      amount,
      category: mapped === "card_payment" ? undefined : extra,
      card: mapped === "card_payment" ? extra : flag("--card"),
      note: flag("--note"),
      date: flag("--date"),
    });
    console.log(`Lançamento ${id} registrado.`);
    if (json) print(cofre.snapshot());
  } else if (command === "card" && process.argv[3] === "add") {
    takeOverFromDemo();
    const id = cofre.addCard({
      name: process.argv[4],
      limit: flag("--limit"),
      closeDay: flag("--close"),
      dueDay: flag("--due"),
    });
    console.log(`Cartão ${id} criado.`);
  } else if (command === "budget" && process.argv[3] === "set") {
    takeOverFromDemo();
    cofre.setBudget(process.argv[4], process.argv[5]);
    console.log("Teto atualizado.");
  } else if (command === "reset") {
    if (!process.argv.includes("--yes")) throw new Error("Use reset --yes para apagar os dados");
    cofre.reset();
    console.log("Dados apagados.");
  } else if (command === "watch") {
    const result = await deliverAlerts(cofre);
    if (result.sent > 0) console.log(`Enviei ${result.sent} alerta(s) ao Telegram.`);
    else if (result.reason === "unconfigured") {
      console.log(formatAlertMessage(result.pending));
      console.log("\nTelegram ainda sem token ou chat. Nada foi marcado como enviado.");
    } else if (result.reason === "quiet-hours") {
      console.log("Fora da janela 08:00–22:00. Vou avisar de manhã.");
    } else {
      console.log("Nada novo para avisar.");
    }
  } else {
    help();
    process.exitCode = 1;
  }
} catch (error) {
  fail(error);
}
