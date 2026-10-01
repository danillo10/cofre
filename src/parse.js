import { normalizeCategory, toCents } from "./money.js";

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
    if (folded.includes(category) || words.some((word) => folded.includes(word))) return category;
  }
  return null;
}

export function parseBudgetRequest(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const folded = fold(raw);
  const asksToSet =
    /\b(coloca|coloque|defina|define|cria|crie|muda|mude|altera|altere|ajusta|ajuste|estabeleca|quero)\b/.test(folded) ||
    /^(teto|orcamento|limite)\b/.test(folded);
  if (!asksToSet || !/\b(teto|orcamento|limite de gasto)\b/.test(folded)) return null;
  const amounts = extractAmounts(raw);
  if (amounts.length === 0) return null;
  const amount = pickAmount(raw, amounts);
  const beforeAmount = fold(raw.slice(0, amount.index))
    .replace(/\b(de|em|no valor de)\s*$/g, "")
    .trim();
  const parts = beforeAmount
    .split(/\b(?:para|de)\b/g)
    .map((part) => part.trim())
    .filter(Boolean);
  let requested = parts.at(-1) || "";
  if (parts.length === 1) {
    requested = requested.replace(/^.*\b(?:teto|orcamento|limite)\b/, "").trim();
  }
  requested = requested
    .replace(/\b(categoria|gasto|gastos|mensal|mensais)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const category = requested ? normalizeCategory(requested) : matchCategory(folded) || "outros";
  return {
    category,
    amountCents: amount.cents,
  };
}

export function parseTransactionMutation(text, transactions = []) {
  const raw = String(text ?? "").trim();
  const folded = fold(raw);
  const deleting = /\b(apaga|apague|exclui|exclua|remove|remova|delete)\b/.test(folded);
  const editing = /\b(edita|edite|corrige|corrija|altera|altere|muda|mude)\b/.test(folded);
  if (!deleting && !editing) return null;

  let target = null;
  const explicitId = raw.match(/#(\d+)|\bid\s*[:#]?\s*(\d+)/i);
  if (explicitId) {
    const id = Number(explicitId[1] || explicitId[2]);
    target = transactions.find((row) => row.id === id) ?? null;
  } else if (/\b(ultima|ultimo|essa|esse)\b/.test(folded)) {
    target = transactions.slice().sort((a, b) => b.id - a.id)[0] ?? null;
  } else {
    const matches = transactions.filter((row) => {
      const labels = [row.category, row.categoryLabel, row.note]
        .map(fold)
        .filter((value) => value.length >= 3);
      return labels.some((value) => folded.includes(value));
    });
    if (matches.length === 1) target = matches[0];
    else if (matches.length > 1) {
      return { error: "Encontrei mais de uma conta parecida. Diga o número, por exemplo: exclua a conta #12." };
    }
  }
  if (!target) {
    return { error: "Não encontrei essa conta. Diga o número mostrado pelo bot, por exemplo: edite a conta #12." };
  }
  if (deleting) return { intent: "delete_transaction", transactionId: target.id };

  const changes = {};
  const amount = raw.match(/\b(?:valor(?:\s+para)?|para)\s*(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+[.,]\d{1,2}|\d+)\b/i);
  if (amount) changes.amountCents = toCents(amount[1]);
  const date = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (date) changes.date = date[1];
  const category = raw.match(/\bcategoria\s+(?:para\s+|como\s+)?([\p{L}][\p{L}\s_-]*?)(?=\s+(?:e|valor|descricao|data)\b|$)/iu);
  if (category) changes.category = normalizeCategory(category[1]);
  const note = raw.match(/\b(?:descricao|descrição|nome|referencia|referência)\s*(?:para|como|:)?\s+(.+)$/iu);
  if (note) changes.note = note[1].trim();
  if (Object.keys(changes).length === 0) {
    return { error: "Diga o que devo corrigir: valor, descrição, data ou categoria." };
  }
  return { intent: "edit_transaction", transactionId: target.id, changes };
}

export function parseLaunch(text, { cards = [], categories = [] } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const folded = fold(raw);
  const command = folded.match(/^(\/start|\/resumo|\/contas)$/);
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
    const custom = categories.find((item) => {
      const id = typeof item === "string" ? item : item.id;
      const label = typeof item === "string" ? item : item.label;
      return folded.includes(fold(id)) || folded.includes(fold(label));
    });
    category = custom ? (typeof custom === "string" ? custom : custom.id) : matchCategory(folded) || "outros";
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
