export const TIMEZONE = "America/Sao_Paulo";

export const EXPENSE_CATEGORIES = [
  ["alimentacao", "Alimentação"],
  ["mercado", "Mercado"],
  ["transporte", "Transporte"],
  ["moradia", "Moradia"],
  ["lazer", "Lazer"],
  ["saude", "Saúde"],
  ["assinaturas", "Assinaturas"],
  ["educacao", "Educação"],
  ["outros", "Outros"],
];

export const INCOME_CATEGORIES = [
  ["salario", "Salário"],
  ["freelance", "Freelance"],
  ["outros", "Outros"],
];

const EXPENSE_IDS = new Set(EXPENSE_CATEGORIES.map(([id]) => id));
const INCOME_IDS = new Set(INCOME_CATEGORIES.map(([id]) => id));

export function categoryLabel(kind, id) {
  const list = kind === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  return list.find(([key]) => key === id)?.[1] ?? id;
}

export function assertCategory(kind, id) {
  if (kind === "card_payment") return "pagamento_cartao";
  const allowed = kind === "income" ? INCOME_IDS : EXPENSE_IDS;
  if (!allowed.has(id)) {
    throw new Error("Categoria inválida");
  }
  return id;
}

export function isoDate(date = new Date(), timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function assertIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Data inválida");
  }
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error("Data inválida");
  }
  return value;
}

export function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

export function nextDueDate(today, dueDay) {
  const [year, month, day] = today.split("-").map(Number);
  let dueYear = year;
  let dueMonth = month;
  if (day > dueDay) {
    dueMonth += 1;
    if (dueMonth > 12) {
      dueMonth = 1;
      dueYear += 1;
    }
  }
  return `${dueYear}-${String(dueMonth).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
}

export function monthBounds(today) {
  const [year, month] = today.split("-").map(Number);
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = addDays(
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
    -1,
  );
  return { start, end, key: start.slice(0, 7) };
}

export function toCents(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0 || input > 1_000_000) {
      throw new Error("Valor inválido");
    }
    return Math.round(input * 100);
  }

  let text = String(input).trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (!text) throw new Error("Valor inválido");

  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error("Valor inválido");
  }

  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new Error("Valor inválido");
  }
  return Math.round(value * 100);
}

export function formatBRL(cents) {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function formatDay(iso) {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

export function assertDayOfMonth(value, label) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    throw new Error(`${label} precisa ser um dia entre 1 e 28`);
  }
  return day;
}

export function cleanNote(value) {
  const note = String(value ?? "").trim().replace(/\s+/g, " ");
  if (note.length > 160) throw new Error("A nota passou de 160 caracteres");
  return note;
}

export function cleanName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40) {
    throw new Error("O nome do cartão precisa ter entre 2 e 40 caracteres");
  }
  return name;
}
