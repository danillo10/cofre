import { toCents } from "./money.js";

const CATEGORIES = [
  ["alimentacao", ["almoco", "jantar", "ifood", "restaurante", "lanche", "padaria", "cafe", "delivery", "pizza", "burger", "acai", "comida"]],
  ["mercado", ["mercado", "supermercado", "feira", "hortifruti", "carrefour", "assai", "atacadao"]],
  ["transporte", ["uber", "99pop", "combustivel", "gasolina", "etanol", "onibus", "metro", "estacionamento", "pedagio"]],
  ["moradia", ["aluguel", "luz", "energia", "agua", "internet", "condominio", "iptu"]],
  ["lazer", ["cinema", "netflix", "bar", "show", "jogo", "viagem"]],
  ["saude", ["farmacia", "medico", "consulta", "exame", "plano de saude"]],
  ["assinaturas", ["assinatura", "spotify", "streaming", "icloud", "youtube premium"]],
  ["educacao", ["curso", "escola", "faculdade", "livro", "mensalidade"]],
];

const AMOUNT_PATTERN =
  /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}|\d+\.\d{2}|\d{1,7})/gi;

export function fold(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function extractAmounts(text) {
  const found = [];
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const raw = match[1];
    const index = match.index + match[0].length - raw.length;
    const before = text[index - 1] ?? "";
    const after = text[index + raw.length] ?? "";
    if (before === "/" || after === "/") continue;
    if (after === "%") continue;
    const prefixed = /r\$\s*$/i.test(text.slice(Math.max(0, index - 4), index));
    const decimals = /[.,]\d{1,2}$/.test(raw);
    const numeric = Number(raw.replace(/\./g, "").replace(",", "."));
    if (!prefixed && !decimals && numeric >= 2020 && numeric <= 2035) continue;
    try {
      found.push({
        cents: toCents(raw),
        index,
        prefixed,
        decimals,
      });
    } catch {
      // ignora pedaço que não é valor
    }
  }
  return found;
}

function pickAmount(text, amounts) {
  const folded = fold(text);
  const marker = Math.max(folded.lastIndexOf("total"), folded.lastIndexOf("a pagar"), folded.lastIndexOf("valor a pagar"));
  if (marker >= 0) {
    const after = amounts.filter((item) => item.index >= marker);
    if (after.length > 0) return after[0];
  }
  const tagged = amounts.filter((item) => item.prefixed);
  if (tagged.length > 0) return tagged[tagged.length - 1];
  const decimals = amounts.filter((item) => item.decimals);
  if (decimals.length > 0) return decimals[decimals.length - 1];
  return amounts[amounts.length - 1];
}

function matchCategory(folded) {
  for (const [category, words] of CATEGORIES) {
    if (words.some((word) => folded.includes(word))) return category;
  }
  return null;
}

export function parseLaunch(text, { cards = [] } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const folded = fold(raw);
  const command = folded.match(/^(\/start|\/resumo)$/);
  if (command) return { command: command[1].replace("/", "") };

  const amounts = extractAmounts(raw);
  if (amounts.length === 0) return null;

  let kind = "expense";
  if (/\b(recebi|salario|renda|entrou|freela|freelance)\b/.test(folded)) kind = "income";
  if (/\b(paguei o cartao|paguei a fatura|pagamento do cartao|pagamento da fatura|abati a fatura|abati o cartao)\b/.test(folded)) {
    kind = "card_payment";
  }

  let category = "outros";
  if (kind === "income") {
    if (folded.includes("freela") || folded.includes("freelance")) category = "freelance";
    else if (folded.includes("salario")) category = "salario";
  } else if (kind === "expense") {
    category = matchCategory(folded) || "outros";
  }

  const card = cards.find((name) => folded.includes(fold(name))) ?? null;
  if (/\b(paguei|pagamento|abati)\b/.test(folded) && card) kind = "card_payment";
  if (kind === "card_payment" && !card) {
    return { error: "Diz qual cartão você pagou. Exemplo: paguei 200 no Nubank." };
  }

  const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? raw;
  return {
    kind,
    amountCents: pickAmount(raw, amounts).cents,
    category,
    card,
    note: firstLine.slice(0, 160),
  };
}
