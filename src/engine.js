import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  addDays,
  assertCategory,
  assertDayOfMonth,
  assertIsoDate,
  categoryLabel,
  cleanName,
  cleanNote,
  daysBetween,
  formatBRL,
  formatDay,
  isoDate,
  monthBounds,
  nextDueDate,
  normalizeCategory,
  toCents,
} from "./money.js";
import { buildSituation } from "./situation.js";

const LEVELS = [
  { level: 1, xp: 0, title: "Aprendiz do caixa" },
  { level: 2, xp: 120, title: "Organizador" },
  { level: 3, xp: 300, title: "Guardião" },
  { level: 4, xp: 600, title: "Estrategista" },
  { level: 5, xp: 1000, title: "Mestre do Cofre" },
];

const SEVERITY = { critico: 0, atencao: 1, info: 2 };

const CHALLENGES = [
  {
    id: "registrar",
    title: "Registrar o dia",
    detail: "Lance pelo menos um movimento hoje.",
  },
  {
    id: "alimentacao",
    title: "Alimentação no teto",
    detail: "Feche o mês com alimentação dentro do orçamento.",
  },
  {
    id: "credito",
    title: "Crédito leve",
    detail: "Deixe todos os cartões abaixo de 30% do limite.",
  },
  {
    id: "pagamento",
    title: "Pagar um pedaço",
    detail: "Registre ao menos um pagamento de cartão neste mês.",
  },
];

function levelFor(xp) {
  let current = LEVELS[0];
  for (const step of LEVELS) {
    if (xp >= step.xp) current = step;
  }
  const next = LEVELS.find((step) => step.xp > xp) ?? null;
  const span = next ? next.xp - current.xp : 1;
  const progress = next ? (xp - current.xp) / span : 1;
  return {
    level: current.level,
    title: current.title,
    xp,
    nextXp: next?.xp ?? null,
    nextTitle: next?.title ?? null,
    remaining: next ? next.xp - xp : 0,
    progress,
  };
}

function isoWeek(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

function streakEnding(days, today) {
  let cursor = days.has(today) ? today : addDays(today, -1);
  if (!days.has(cursor)) return 0;
  let count = 0;
  while (days.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

export function projectRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

export function defaultDbPath() {
  return process.env.COFRE_DB || path.join(projectRoot(), "data", "cofre.sqlite");
}

export class Cofre {
  constructor(dbPath = defaultDbPath()) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        limit_cents INTEGER NOT NULL,
        close_day INTEGER NOT NULL,
        due_day INTEGER NOT NULL,
        balance_cents INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS budgets (
        category TEXT PRIMARY KEY,
        limit_cents INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY,
        occurred_on TEXT NOT NULL,
        logged_on TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        card_id INTEGER,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'painel',
        raw_text TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (card_id) REFERENCES cards(id)
      );
      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_chat
        ON conversation_messages(chat_id, id);
      CREATE TABLE IF NOT EXISTS alert_log (
        fingerprint TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        agent TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        sent_at TEXT,
        sent_on TEXT
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(transactions)").all().map((column) => column.name);
    if (!columns.includes("source")) {
      this.db.exec("ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'painel'");
    }
    if (!columns.includes("raw_text")) {
      this.db.exec("ALTER TABLE transactions ADD COLUMN raw_text TEXT NOT NULL DEFAULT ''");
    }
  }

  claimUpdate(updateId) {
    try {
      this.db.prepare("INSERT INTO telegram_updates(update_id) VALUES (?)").run(updateId);
      return true;
    } catch {
      return false;
    }
  }

  addConversationMessage(chatId, role, content) {
    if (!["user", "assistant"].includes(role)) throw new Error("Papel de conversa inválido");
    const safe = String(content ?? "").trim().slice(0, 4000);
    if (!safe) return;
    const id = String(chatId);
    this.db
      .prepare("INSERT INTO conversation_messages(chat_id, role, content, created_at) VALUES(?, ?, ?, ?)")
      .run(id, role, safe, new Date().toISOString());
    this.db
      .prepare(`
        DELETE FROM conversation_messages
        WHERE chat_id = ?
          AND id NOT IN (
            SELECT id FROM conversation_messages
            WHERE chat_id = ?
            ORDER BY id DESC
            LIMIT 50
          )
      `)
      .run(id, id);
  }

  conversationHistory(chatId, limit = 20) {
    const rows = this.db
      .prepare(`
        SELECT role, content
        FROM conversation_messages
        WHERE chat_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(String(chatId), Math.max(1, Math.min(50, Number(limit) || 20)));
    return rows.reverse();
  }

  setting(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : fallback;
  }

  putSetting(key, value) {
    this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  isDemo() {
    return this.setting("demo") === "1";
  }

  isEmpty() {
    const cards = Number(this.db.prepare("SELECT COUNT(*) AS n FROM cards").get().n);
    const movements = Number(this.db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n);
    return cards === 0 && movements === 0;
  }

  today() {
    return isoDate();
  }

  withTransaction(work) {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  findCard(card) {
    if (card === undefined || card === null || card === "") return null;
    if (typeof card === "number" || /^\d+$/.test(String(card))) {
      const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(Number(card));
      if (!row) throw new Error("Cartão não encontrado");
      return row;
    }
    const row = this.db
      .prepare("SELECT * FROM cards WHERE name = ? COLLATE NOCASE")
      .get(String(card).trim());
    if (!row) throw new Error("Cartão não encontrado");
    return row;
  }

  addCard({ name, limit, closeDay, dueDay }) {
    const clean = cleanName(name);
    const limitCents = toCents(limit);
    const close = assertDayOfMonth(closeDay, "O fechamento");
    const due = assertDayOfMonth(dueDay, "O vencimento");
    try {
      const result = this.db
        .prepare(
          "INSERT INTO cards(name, limit_cents, close_day, due_day, balance_cents) VALUES(?, ?, ?, ?, 0)",
        )
        .run(clean, limitCents, close, due);
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new Error("Já existe um cartão com esse nome");
      }
      throw error;
    }
  }

  setBudget(category, limit) {
    const normalized = normalizeCategory(category);
    let id = normalized;
    try {
      id = assertCategory("expense", normalized);
    } catch {
      // Tetos também criam categorias personalizadas.
    }
    const cents = toCents(limit);
    this.db
      .prepare(
        "INSERT INTO budgets(category, limit_cents) VALUES(?, ?) ON CONFLICT(category) DO UPDATE SET limit_cents = excluded.limit_cents",
      )
      .run(id, cents);
  }

  deleteBudget(category) {
    const id = normalizeCategory(category);
    this.db.prepare("DELETE FROM budgets WHERE category = ?").run(id);
  }

  addTransaction({ kind, amount, amountCents, category, card, note, date, loggedOn, source = "painel", rawText = "" }) {
    if (!["expense", "income", "card_payment"].includes(kind)) {
      throw new Error("Tipo de lançamento inválido");
    }
    const cents = amountCents ?? toCents(amount);
    if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_000) {
      throw new Error("Valor inválido");
    }
    const origin = ["painel", "telegram", "demo"].includes(source) ? source : "painel";
    const raw = String(rawText ?? "").trim().slice(0, 500);
    const occurredOn = assertIsoDate(date || this.today());
    const logged = assertIsoDate(loggedOn || this.today());
    const safeNote = cleanNote(note);
    let categoryId = "pagamento_cartao";
    if (kind !== "card_payment") {
      const normalized = normalizeCategory(category);
      try {
        categoryId = assertCategory(kind, normalized);
      } catch (error) {
        const custom = kind === "expense" &&
          this.db.prepare("SELECT 1 FROM budgets WHERE category = ?").get(normalized);
        if (!custom) throw error;
        categoryId = normalized;
      }
    }
    const cardRow = kind === "income" ? null : this.findCard(card);
    if (kind === "card_payment" && !cardRow) {
      throw new Error("Pagamento precisa de um cartão");
    }
    if (kind === "card_payment" && cents > cardRow.balance_cents) {
      throw new Error("O pagamento é maior do que a fatura em aberto");
    }

    return this.withTransaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO transactions(occurred_on, logged_on, amount_cents, kind, category, card_id, note, created_at, source, raw_text)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          occurredOn,
          logged,
          cents,
          kind,
          categoryId,
          cardRow?.id ?? null,
          safeNote,
          new Date().toISOString(),
          origin,
          raw,
        );
      if (cardRow && kind === "expense") {
        this.db
          .prepare("UPDATE cards SET balance_cents = balance_cents + ? WHERE id = ?")
          .run(cents, cardRow.id);
      }
      if (cardRow && kind === "card_payment") {
        this.db
          .prepare("UPDATE cards SET balance_cents = balance_cents - ? WHERE id = ?")
          .run(cents, cardRow.id);
      }
      return Number(result.lastInsertRowid);
    });
  }

  deleteTransaction(id) {
    const row = this.db.prepare("SELECT * FROM transactions WHERE id = ?").get(Number(id));
    if (!row) throw new Error("Lançamento não encontrado");
    this.withTransaction(() => {
      if (row.card_id && row.kind === "expense") {
        this.db
          .prepare("UPDATE cards SET balance_cents = MAX(0, balance_cents - ?) WHERE id = ?")
          .run(row.amount_cents, row.card_id);
      }
      if (row.card_id && row.kind === "card_payment") {
        this.db
          .prepare("UPDATE cards SET balance_cents = balance_cents + ? WHERE id = ?")
          .run(row.amount_cents, row.card_id);
      }
      this.db.prepare("DELETE FROM transactions WHERE id = ?").run(row.id);
    });
  }

  reset() {
    this.withTransaction(() => {
      this.db.exec("DELETE FROM transactions; DELETE FROM budgets; DELETE FROM cards; DELETE FROM alert_log; DELETE FROM settings;");
    });
  }

  seedDemo() {
    this.reset();
    this.putSetting("demo", "1");
    const today = this.today();
    const { start } = monthBounds(today);
    const dueDay = dueDayWithin(today, 2);
    const closeDay = dueDay > 7 ? dueDay - 7 : Math.min(28, dueDay + 14);

    const nubank = this.addCard({
      name: "Nubank",
      limit: 4000,
      closeDay,
      dueDay,
    });
    const interDue = dueDayAhead(today, 10);
    const inter = this.addCard({
      name: "Inter",
      limit: 2000,
      closeDay: interDue > 7 ? interDue - 7 : interDue + 7,
      dueDay: interDue,
    });

    this.setBudget("alimentacao", 600);
    this.setBudget("lazer", 300);
    this.setBudget("transporte", 900);

    const place = (iso) => {
      if (iso < start) return start;
      if (iso > today) return today;
      return iso;
    };
    const early = place(addDays(start, 1));
    const yesterday = addDays(today, -1);
    const twoDaysAgo = addDays(today, -2);

    const movements = [
      ["income", 5200, "salario", null, "Salário", early, early],
      ["expense", 180, "alimentacao", null, "Almoço", early, early],
      ["expense", 160, "alimentacao", null, "Feira", early, early],
      ["expense", 190, "alimentacao", null, "Jantar", early, early],
      ["expense", 170, "alimentacao", null, "Padaria e café", place(yesterday), yesterday],
      ["expense", 30, "alimentacao", null, "Café", today, twoDaysAgo],
      ["expense", 900, "mercado", nubank, "Compra do mês", early, early],
      ["expense", 500, "transporte", nubank, "Combustível", early, early],
      ["expense", 120, "assinaturas", nubank, "Streaming", early, early],
      ["expense", 1400, "outros", nubank, "Compra parcelada", early, early],
      ["expense", 80, "transporte", inter, "Aplicativo", early, early],
      ["expense", 140, "lazer", null, "Cinema", today, today],
      ["card_payment", 50, null, nubank, "Pagamento parcial", today, today],
    ];

    for (const [kind, amount, category, card, note, date, loggedOn] of movements) {
      this.addTransaction({ kind, amount, category, card, note, date, loggedOn });
    }
  }

  snapshot() {
    const today = this.today();
    const month = monthBounds(today);
    const cards = this.db.prepare("SELECT * FROM cards ORDER BY name COLLATE NOCASE").all();
    const budgets = this.db.prepare("SELECT * FROM budgets").all();
    const transactions = this.db
      .prepare("SELECT * FROM transactions ORDER BY occurred_on DESC, id DESC")
      .all();
    const monthRows = transactions.filter(
      (row) => row.occurred_on >= month.start && row.occurred_on <= month.end,
    );

    const spentByCategory = {};
    let monthExpense = 0;
    let monthIncome = 0;
    let todayExpense = 0;
    for (const row of monthRows) {
      if (row.kind === "expense") {
        monthExpense += row.amount_cents;
        spentByCategory[row.category] = (spentByCategory[row.category] ?? 0) + row.amount_cents;
        if (row.occurred_on === today) todayExpense += row.amount_cents;
      }
      if (row.kind === "income") monthIncome += row.amount_cents;
    }

    let cash = 0;
    for (const row of transactions) {
      if (row.kind === "income") cash += row.amount_cents;
      if (row.kind === "expense" && !row.card_id) cash -= row.amount_cents;
      if (row.kind === "card_payment") cash -= row.amount_cents;
    }

    const windowStart = addDays(today, -14);
    let prevSpend = 0;
    for (const row of transactions) {
      if (row.kind !== "expense") continue;
      if (row.occurred_on >= windowStart && row.occurred_on < today) {
        prevSpend += row.amount_cents;
      }
    }

    const loggedDays = new Set(transactions.map((row) => row.logged_on));
    let xp = 0;
    let payments = 0;
    for (const row of transactions) {
      if (row.kind === "expense") xp += 12;
      if (row.kind === "income") xp += 18;
      if (row.kind === "card_payment") {
        xp += 30;
        payments += 1;
      }
      if (row.logged_on === row.occurred_on) xp += 8;
    }
    const streak = streakEnding(loggedDays, today);
    if (streak >= 3) xp += 20;
    if (streak >= 7) xp += 40;

    const game = levelFor(xp);
    const cardViews = cards.map((card) => {
      const ratio = card.limit_cents > 0 ? card.balance_cents / card.limit_cents : 0;
      const dueOn = nextDueDate(today, card.due_day);
      return {
        id: card.id,
        name: card.name,
        limitCents: card.limit_cents,
        balanceCents: card.balance_cents,
        closeDay: card.close_day,
        dueDay: card.due_day,
        dueOn,
        daysUntilDue: daysBetween(today, dueOn),
        ratio,
      };
    });

    const budgetViews = budgets.map((budget) => {
      const spent = spentByCategory[budget.category] ?? 0;
      return {
        category: budget.category,
        label: categoryLabel("expense", budget.category),
        limitCents: budget.limit_cents,
        spentCents: spent,
        ratio: budget.limit_cents > 0 ? spent / budget.limit_cents : 0,
      };
    });

    const alerts = buildAlerts({
      today,
      todayExpense,
      prevSpend,
      budgetViews,
      cardViews,
    });
    this.syncAlerts(alerts);

    const demo = this.isDemo();
    const stored = this.db.prepare("SELECT * FROM alert_log").all();
    const storedById = new Map(stored.map((row) => [row.fingerprint, row]));
    const alertViews = alerts
      .map((alert) => {
        const row = storedById.get(alert.fingerprint);
        const pending = isPending(row, today, demo);
        return { ...alert, pending };
      })
      .sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);

    const challenge = buildChallenge({
      today,
      loggedToday: loggedDays.has(today),
      budgetViews,
      cardViews,
      paymentsThisMonth: monthRows.filter((row) => row.kind === "card_payment").length,
    });

    const badges = buildBadges({
      transactions,
      streak,
      monthIncome,
      monthExpense,
      cardViews,
      budgetViews,
      payments,
      today,
    });

    const situation = buildSituation({
      today,
      monthIncome,
      monthExpense,
      budgetViews,
      cardViews,
      transactions,
    });

    const agents = buildAgents({
      monthIncome,
      monthExpense,
      spentByCategory,
      alertViews,
      cardViews,
      game,
      streak,
      challenge,
      situation,
    });

    const recent = transactions.slice(0, 40).map((row) => ({
      id: row.id,
      occurredOn: row.occurred_on,
      amountCents: row.amount_cents,
      kind: row.kind,
      category: row.category,
      categoryLabel:
        row.kind === "card_payment" ? "Pagamento" : categoryLabel(row.kind, row.category),
      cardId: row.card_id,
      cardName: cards.find((card) => card.id === row.card_id)?.name ?? null,
      note: row.note,
      source: row.source || "painel",
    }));

    return {
      today,
      month: month.key,
      demo,
      cashCents: cash,
      monthIncomeCents: monthIncome,
      monthExpenseCents: monthExpense,
      monthResultCents: monthIncome - monthExpense,
      todayExpenseCents: todayExpense,
      cards: cardViews,
      budgets: budgetViews,
      transactions: recent,
      alerts: alertViews,
      game: { ...game, streak, badges },
      situation,
      challenge,
      agents,
      categories: {
        expense: [
          ...EXPENSE_CATEGORIES.map(([id, label]) => ({ id, label })),
          ...budgets
            .filter((budget) => !EXPENSE_CATEGORIES.some(([id]) => id === budget.category))
            .map((budget) => ({
              id: budget.category,
              label: categoryLabel("expense", budget.category),
            })),
        ],
        income: INCOME_CATEGORIES.map(([id, label]) => ({ id, label })),
      },
    };
  }

  syncAlerts(alerts) {
    const current = new Set(alerts.map((alert) => alert.fingerprint));
    const existing = this.db.prepare("SELECT * FROM alert_log").all();
    const byId = new Map(existing.map((row) => [row.fingerprint, row]));
    const upsert = this.db.prepare(`
      INSERT INTO alert_log(fingerprint, level, agent, title, body, active, sent_at, sent_on)
      VALUES(?, ?, ?, ?, ?, 1, NULL, NULL)
      ON CONFLICT(fingerprint) DO UPDATE SET
        level = excluded.level,
        agent = excluded.agent,
        title = excluded.title,
        body = excluded.body,
        active = 1,
        sent_at = CASE WHEN alert_log.active = 0 THEN NULL ELSE alert_log.sent_at END,
        sent_on = CASE WHEN alert_log.active = 0 THEN NULL ELSE alert_log.sent_on END
    `);
    const deactivate = this.db.prepare(
      "UPDATE alert_log SET active = 0 WHERE fingerprint = ?",
    );
    this.withTransaction(() => {
      for (const alert of alerts) {
        if (!byId.has(alert.fingerprint) || byId.get(alert.fingerprint).active === 0) {
          upsert.run(alert.fingerprint, alert.level, alert.agent, alert.title, alert.body);
        } else {
          this.db
            .prepare(
              "UPDATE alert_log SET level = ?, agent = ?, title = ?, body = ?, active = 1 WHERE fingerprint = ?",
            )
            .run(alert.level, alert.agent, alert.title, alert.body, alert.fingerprint);
        }
      }
      for (const row of existing) {
        if (row.active && !current.has(row.fingerprint)) deactivate.run(row.fingerprint);
      }
    });
  }

  pendingAlerts() {
    const state = this.snapshot();
    return state.alerts.filter((alert) => alert.pending);
  }

  markSent(fingerprints) {
    const today = this.today();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE alert_log SET sent_at = ?, sent_on = ? WHERE fingerprint = ?",
    );
    this.withTransaction(() => {
      for (const fingerprint of fingerprints) stmt.run(now, today, fingerprint);
    });
  }
}

function isPending(row, today, demo) {
  if (demo || !row?.active) return false;
  if (!row.sent_on) return true;
  return row.level === "critico" && row.sent_on < today;
}

function buildAlerts({ today, todayExpense, prevSpend, budgetViews, cardViews }) {
  const alerts = [];
  for (const budget of budgetViews) {
    if (budget.spentCents <= 0) continue;
    if (budget.ratio >= 1) {
      alerts.push({
        fingerprint: `budget:${budget.category}:${today.slice(0, 7)}:over`,
        level: "critico",
        agent: "Nara",
        title: `${budget.label} estourou o teto`,
        body: `${formatBRL(budget.spentCents)} de ${formatBRL(budget.limitCents)} neste mês. O próximo gasto nessa categoria aumenta o rombo.`,
      });
    } else if (budget.ratio >= 0.8) {
      alerts.push({
        fingerprint: `budget:${budget.category}:${today.slice(0, 7)}:warn`,
        level: "atencao",
        agent: "Nara",
        title: `${budget.label} chegou a ${Math.round(budget.ratio * 100)}%`,
        body: `Já foram ${formatBRL(budget.spentCents)} de ${formatBRL(budget.limitCents)}. Ainda cabem ${formatBRL(budget.limitCents - budget.spentCents)}.`,
      });
    }
  }

  for (const card of cardViews) {
    const percent = Math.round(card.ratio * 100);
    let bucket = null;
    let level = "info";
    if (card.ratio >= 0.7) {
      bucket = "70";
      level = "critico";
    } else if (card.ratio >= 0.5) {
      bucket = "50";
      level = "atencao";
    } else if (card.ratio >= 0.3) {
      bucket = "30";
      level = "info";
    }
    if (bucket) {
      alerts.push({
        fingerprint: `credit:${card.id}:${bucket}`,
        level,
        agent: "Vigia",
        title:
          level === "critico"
            ? `${card.name} passou de 70% do limite`
            : `${card.name} está em ${percent}% do limite`,
        body: `Fatura em ${formatBRL(card.balanceCents)} de ${formatBRL(card.limitCents)}. Um pagamento agora baixa esse alerta.`,
      });
    }
    if (card.daysUntilDue >= 0 && card.daysUntilDue <= 3 && card.balanceCents > 0) {
      const when =
        card.daysUntilDue === 0
          ? "vence hoje"
          : card.daysUntilDue === 1
            ? "vence amanhã"
            : `vence em ${card.daysUntilDue} dias`;
      alerts.push({
        fingerprint: `due:${card.id}:${card.dueOn}`,
        level: card.daysUntilDue === 0 ? "critico" : "atencao",
        agent: "Vigia",
        title: `${card.name} ${when}`,
        body: `Vencimento em ${formatDay(card.dueOn)}, com ${formatBRL(card.balanceCents)} em aberto.`,
      });
    }
  }

  const avg = prevSpend / 14;
  const spikeLine = Math.max(25000, avg * 2.5);
  if (todayExpense >= spikeLine && todayExpense >= 25000) {
    alerts.push({
      fingerprint: `spike:${today}`,
      level: "atencao",
      agent: "Nara",
      title: "O gasto de hoje saiu do ritmo",
      body: `Hoje já foram ${formatBRL(todayExpense)}. A média dos 14 dias anteriores foi ${formatBRL(Math.round(avg))} por dia.`,
    });
  }

  return alerts;
}

function buildBadges({
  transactions,
  streak,
  monthIncome,
  monthExpense,
  cardViews,
  budgetViews,
  payments,
  today,
}) {
  const day = Number(today.slice(-2));
  const badges = [];
  const add = (id, name, earned, hint) => badges.push({ id, name, earned, hint });
  add("primeiro", "Primeiro lançamento", transactions.length > 0, "Registre qualquer movimento.");
  add("sequencia3", "3 dias seguidos", streak >= 3, "Lance algo por três dias.");
  add("sequencia7", "Semana inteira", streak >= 7, "Não pule um dia por uma semana.");
  add("pagador", "Pagador", payments > 0, "Registre um pagamento de cartão.");
  add(
    "credito",
    "Crédito leve",
    cardViews.length > 0 && cardViews.every((card) => card.ratio < 0.3),
    "Deixe todos os cartões abaixo de 30%.",
  );
  add(
    "orcamento",
    "Mês no plano",
    day >= 7 &&
      budgetViews.length > 0 &&
      budgetViews.every((budget) => budget.ratio < 1) &&
      monthExpense > 0,
    "Passe do dia 7 sem estourar um teto.",
  );
  add(
    "azul",
    "Mês no azul",
    day >= 7 && monthIncome > monthExpense && monthExpense > 0,
    "Receitas maiores que os gastos depois do dia 7.",
  );
  return badges;
}

function buildChallenge({ today, loggedToday, budgetViews, cardViews, paymentsThisMonth }) {
  const spec = CHALLENGES[isoWeek(today) % CHALLENGES.length];
  if (spec.id === "registrar") {
    return {
      ...spec,
      meterKind: "progress",
      done: loggedToday,
      meter: loggedToday ? 1 : 0,
      status: loggedToday ? "Feito hoje" : "Ainda falta um lançamento",
    };
  }
  if (spec.id === "alimentacao") {
    const budget = budgetViews.find((item) => item.category === "alimentacao");
    if (!budget) {
      return { ...spec, meterKind: "usage", done: false, meter: 0, status: "Defina um teto de alimentação" };
    }
    return {
      ...spec,
      meterKind: "usage",
      done: budget.ratio <= 1,
      meter: Math.min(1, budget.ratio),
      status: `${formatBRL(budget.spentCents)} de ${formatBRL(budget.limitCents)}`,
    };
  }
  if (spec.id === "credito") {
    if (cardViews.length === 0) {
      return { ...spec, meterKind: "usage", done: false, meter: 0, status: "Cadastre um cartão" };
    }
    const worst = Math.max(...cardViews.map((card) => card.ratio));
    return {
      ...spec,
      meterKind: "usage",
      done: worst < 0.3,
      meter: Math.min(1, worst),
      status: `Pior cartão em ${Math.round(worst * 100)}%`,
    };
  }
  return {
    ...spec,
    meterKind: "progress",
    done: paymentsThisMonth > 0,
    meter: paymentsThisMonth > 0 ? 1 : 0,
    status: paymentsThisMonth > 0 ? "Pagamento registrado neste mês" : "Nenhum pagamento neste mês",
  };
}

function buildAgents({ monthIncome, monthExpense, spentByCategory, alertViews, cardViews, game, streak, challenge, situation }) {
  const top = Object.entries(spentByCategory).sort((a, b) => b[1] - a[1])[0];
  const result = monthIncome - monthExpense;
  let naraLine = "Ainda não há lançamentos neste mês. Manda um gasto ou uma receita.";
  if (monthIncome > 0 || monthExpense > 0) {
    const topText = top ? ` O maior peso é ${categoryLabel("expense", top[0])}, com ${formatBRL(top[1])}.` : "";
    naraLine = `Entrou ${formatBRL(monthIncome)} e saiu ${formatBRL(monthExpense)}. ${result >= 0 ? "O mês está no azul." : "O mês está no vermelho."}${topText}`;
  }

  const vigiaAlerts = alertViews.filter((alert) => alert.agent === "Vigia");
  let vigiaLine = "Nenhum cartão passou de 30% e nada relevante vence nos próximos 3 dias.";
  if (cardViews.length === 0) {
    vigiaLine = "Sem cartão cadastrado. Quando você adicionar um, eu vigio limite e vencimento.";
  } else if (vigiaAlerts.length > 0) {
    vigiaLine = vigiaAlerts[0].body;
  }

  const nextText = game.nextTitle
    ? `Faltam ${game.remaining} XP para ${game.nextTitle}.`
    : "Você chegou ao topo da trilha.";
  const lumaLine = `Situação ${situation.headline.toLowerCase()}. Nível ${game.level}, ${game.title}. ${nextText} Sequência de ${streak} dia${streak === 1 ? "" : "s"}.`;

  return [
    {
      id: "nara",
      name: "Nara",
      role: "Tesoureira",
      focus: "Gastos, receitas e tetos",
      line: naraLine,
      tone: alertViews.some((alert) => alert.agent === "Nara" && alert.level !== "info") ? "warn" : "ok",
    },
    {
      id: "vigia",
      name: "Vigia",
      role: "Crédito",
      focus: "Limite, fatura e vencimento",
      line: vigiaLine,
      tone: vigiaAlerts.some((alert) => alert.level === "critico")
        ? "bad"
        : vigiaAlerts.length
          ? "warn"
          : "ok",
    },
    {
      id: "luma",
      name: "Luma",
      role: "Coach",
      focus: "XP, selos e desafios",
      line: lumaLine,
      tone: "ok",
    },
  ];
}

function dueDayAhead(today, offset) {
  let cursor = addDays(today, offset);
  if (Number(cursor.slice(-2)) > 28) cursor = addDays(cursor, 4);
  const day = Number(cursor.slice(-2));
  return Math.min(28, Math.max(1, day));
}

function dueDayWithin(today, offset) {
  let cursor = addDays(today, offset);
  let day = Number(cursor.slice(-2));
  if (day <= 28) {
    const dueOn = nextDueDate(today, day);
    const delta = daysBetween(today, dueOn);
    if (delta >= 0 && delta <= 3) return day;
  }
  for (let step = 0; step <= 3; step += 1) {
    cursor = addDays(today, step);
    day = Number(cursor.slice(-2));
    if (day > 28) continue;
    const dueOn = nextDueDate(today, day);
    if (daysBetween(today, dueOn) === step) return day;
  }
  return Math.min(28, Math.max(1, Number(today.slice(-2))));
}

export function loadEnv(file = path.join(projectRoot(), ".env")) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
