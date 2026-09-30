const brl = (cents) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const day = (iso) => {
  const [year, month, date] = iso.split("-");
  return `${date}/${month}/${year}`;
};

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const toast = document.querySelector("#toast");
let state = null;

function showError(error) {
  toast.hidden = false;
  toast.textContent = error.message || "Não consegui concluir.";
}

function clearError() {
  toast.hidden = true;
  toast.textContent = "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Falha na requisição");
    error.code = data.code;
    throw error;
  }
  return data;
}

async function mutate(path, options, retryBody) {
  try {
    state = await api(path, options);
    clearError();
    render();
    return true;
  } catch (error) {
    if (error.code === "DEMO") {
      const ok = confirm("Isso apaga o mês de exemplo e passa a valer os seus lançamentos. Continuar?");
      if (!ok) return false;
      try {
        state = await api(path, {
          ...options,
          body: { ...retryBody, replaceDemo: true },
        });
      } catch (retryError) {
        showError(retryError);
        return false;
      }
      clearError();
      render();
      return true;
    }
    showError(error);
    return false;
  }
}

function fillSelect(select, options, placeholder) {
  select.replaceChildren();
  if (placeholder) select.append(el("option", { value: "" }, placeholder));
  for (const option of options) {
    select.append(el("option", { value: option.id }, option.label));
  }
}

function syncForm() {
  const form = document.querySelector("#move-form");
  const kind = form.kind.value;
  const categories = kind === "income" ? state.categories.income : state.categories.expense;
  fillSelect(form.category, categories);
  fillSelect(
    form.card,
    state.cards.map((card) => ({ id: String(card.id), label: card.name })),
    kind === "card_payment" ? null : "À vista, sem cartão",
  );
  document.querySelector("#category-label").hidden = kind === "card_payment";
  form.category.required = kind !== "card_payment";
  form.card.required = kind === "card_payment";
  if (!form.date.value) form.date.value = state.today;
  fillSelect(document.querySelector("#budget-form").category, state.categories.expense);
}

function render() {
  const game = state.game;
  document.querySelector("#level").replaceChildren(
    el("span", {}, `Nível ${game.level}`),
    el("strong", {}, game.title),
    el("div", { class: "xp" }, el("span", { style: `width:${Math.round(game.progress * 100)}%` })),
    el("small", { class: "muted" }, game.nextTitle ? `${game.xp} XP · faltam ${game.remaining} XP` : `${game.xp} XP`),
  );

  const banner = document.querySelector("#banner");
  banner.replaceChildren();
  if (state.demo) {
    banner.append(
      el("div", { class: "banner" }, [
        el("strong", {}, "Mês de exemplo. "),
        "No Telegram, responda SIM para zerar e lançar o primeiro valor de verdade.",
      ]),
    );
  }

  const situation = state.situation;
  const maxWeek = Math.max(...situation.weeks.map((week) => week.cents), 1);
  document.querySelector("#situation").className = `situation ${situation.tone}`;
  document.querySelector("#situation").replaceChildren(
    el("div", {}, [
      el("p", { class: "eyebrow" }, situation.trend === "piorando" ? "Tendência piorando" : situation.trend === "melhorando" ? "Tendência melhorando" : "Tendência estável"),
      el("h2", { class: "headline" }, situation.headline),
      el("p", { class: "score" }, `${situation.score}/100`),
      el("p", {}, situation.summary),
    ]),
    el("div", {}, situation.factors.map((factor) =>
      el("div", { class: "factor" }, [
        el("div", { class: "meta" }, [el("strong", {}, factor.label), el("span", {}, factor.word)]),
        el("div", { class: `meter ${factor.tone === "bad" ? "over" : factor.tone === "warn" ? "usage" : ""}` }, [
          el("span", { style: `width:${factor.score}%` }),
        ]),
        el("p", { class: "muted" }, factor.detail),
      ]),
    )),
    el("div", {}, [
      el("strong", {}, "Gasto por semana"),
      el("div", { class: "weeks" }, situation.weeks.map((week) =>
        el("div", {}, [
          el("i", { style: `height:${Math.max(4, Math.round((week.cents / maxWeek) * 78))}px`, title: brl(week.cents) }),
          el("small", {}, week.label),
        ]),
      )),
      el("p", { class: "muted" }, `7 dias: ${brl(situation.recentCents)} · anterior: ${brl(situation.priorCents)}`),
    ]),
  );

  document.querySelector("#agents").replaceChildren(
    ...state.agents.map((agent) =>
      el("article", { class: `agent ${agent.tone}` }, [
        el("small", {}, `${agent.role} · ${agent.focus}`),
        el("h3", {}, agent.name),
        el("p", {}, agent.line),
      ]),
    ),
  );

  const resultClass = state.monthResultCents >= 0 ? "up" : "down";
  const stats = [
    ["Caixa", state.cashCents, ""],
    ["Gastos do mês", state.monthExpenseCents, "down"],
    ["Receitas do mês", state.monthIncomeCents, "up"],
    ["Resultado", state.monthResultCents, resultClass],
  ];
  document.querySelector("#stats").replaceChildren(
    ...stats.map(([label, cents, tone]) =>
      el("article", { class: "stat" }, [
        el("span", {}, label),
        el("p", { class: `money ${tone}` }, brl(cents)),
      ]),
    ),
  );

  const budgets = document.querySelector("#budgets");
  budgets.replaceChildren();
  if (state.budgets.length === 0) {
    budgets.append(el("p", { class: "empty" }, "Nenhum teto definido."));
  }
  for (const budget of state.budgets) {
    const over = budget.ratio >= 1;
    const width = Math.min(100, Math.round(budget.ratio * 100));
    budgets.append(
      el("div", { class: "row" }, [
        el("div", { class: "meta" }, [
          el("strong", {}, budget.label),
          el("span", {}, `${brl(budget.spentCents)} de ${brl(budget.limitCents)}`),
        ]),
        el("div", { class: `meter ${over ? "over" : "usage"}` }, el("span", { style: `width:${width}%` })),
      ]),
    );
  }

  const cards = document.querySelector("#cards");
  cards.replaceChildren();
  if (state.cards.length === 0) {
    cards.append(el("p", { class: "empty" }, "Nenhum cartão ainda."));
  }
  for (const card of state.cards) {
    const percent = Math.round(card.ratio * 100);
    const due =
      card.daysUntilDue === 0
        ? "vence hoje"
        : card.daysUntilDue === 1
          ? "vence amanhã"
          : `vence em ${card.daysUntilDue} dias`;
    cards.append(
      el("div", { class: "card-block" }, [
        el("div", { class: "meta" }, [
          el("strong", {}, card.name),
          el("span", {}, `${percent}% · ${due}`),
        ]),
        el("div", { class: `meter ${card.ratio >= 0.7 ? "over" : "usage"}` }, [
          el("span", { style: `width:${Math.min(100, percent)}%` }),
        ]),
        el("p", { class: "muted" }, `${brl(card.balanceCents)} de ${brl(card.limitCents)} · fecha dia ${card.closeDay}`),
      ]),
    );
  }

  const alerts = document.querySelector("#alerts");
  alerts.replaceChildren();
  if (state.alerts.length === 0) {
    alerts.append(el("p", { class: "empty" }, "Nada pedindo atenção agora."));
  }
  for (const alert of state.alerts) {
    alerts.append(
      el("article", { class: "alert" }, [
        el("b", {}, [el("span", { class: `tag ${alert.level}` }, alert.agent), ` ${alert.title}`]),
        el("span", { class: "muted" }, alert.body),
      ]),
    );
  }

  const telegram = state.telegram?.listening
    ? "Manda no Telegram um texto, como 42,90 almoço, ou a foto do cupom. O valor entra aqui sozinho."
    : "Para lançar por mensagem, coloque o token do bot no .env e reinicie. Texto e foto passam a cair neste painel.";
  document.querySelector("#telegram").textContent = telegram;

  const challenge = state.challenge;
  document.querySelector("#challenge").replaceChildren(
    el("strong", {}, challenge.title),
    el("p", { class: "muted" }, challenge.detail),
    el("p", {}, challenge.status),
    el(
      "div",
      { class: `meter ${challenge.meterKind === "usage" && challenge.meter >= 0.8 ? "over" : challenge.meterKind}` },
      el("span", { style: `width:${Math.round(challenge.meter * 100)}%` }),
    ),
  );

  document.querySelector("#badges").replaceChildren(
    ...state.game.badges.map((badge) =>
      el("span", { class: badge.earned ? "badge on" : "badge", title: badge.hint }, badge.name),
    ),
  );

  const rows = document.querySelector("#rows");
  rows.replaceChildren();
  if (state.transactions.length === 0) {
    rows.append(el("tr", {}, el("td", { colspan: "5" }, "Nenhum lançamento.")));
  }
  for (const row of state.transactions) {
    const sign = row.kind === "income" ? "up" : row.kind === "expense" ? "down" : "";
    rows.append(
      el("tr", {}, [
        el("td", {}, day(row.occurredOn)),
        el("td", {}, [
          el("strong", {}, row.categoryLabel),
          row.source === "telegram" ? el("span", { class: "tag" }, " Telegram") : null,
          el("div", { class: "muted" }, row.note || "Sem nota"),
        ]),
        el("td", {}, row.cardName || "À vista"),
        el("td", { class: `num money ${sign}` }, brl(row.amountCents)),
        el(
          "td",
          {},
          el("button", { class: "icon-button", type: "button", onclick: () => removeRow(row.id) }, "Apagar"),
        ),
      ]),
    );
  }

  document.querySelector("#demo-button").textContent = state.demo ? "Recarregar exemplo" : "Ver exemplo";
  syncForm();
}

async function removeRow(id) {
  if (state.demo) {
    showError(new Error("Zere o exemplo antes de apagar lançamentos."));
    return;
  }
  if (!confirm("Apagar este lançamento?")) return;
  try {
    state = await api(`/api/transactions/${id}`, { method: "DELETE", body: {} });
    clearError();
    render();
  } catch (error) {
    showError(error);
  }
}

document.querySelector("#move-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    kind: form.kind.value,
    amount: form.amount.value,
    category: form.category.value,
    card: form.card.value || null,
    note: form.note.value,
    date: form.date.value,
  };
  form.querySelector("button").disabled = true;
  const saved = await mutate("/api/transactions", { method: "POST", body }, body);
  form.querySelector("button").disabled = false;
  if (!saved) return;
  form.amount.value = "";
  form.note.value = "";
});

document.querySelector("#move-form").kind.addEventListener("change", syncForm);

document.querySelector("#budget-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = { category: form.category.value, limit: form.limit.value };
  const saved = await mutate("/api/budgets", { method: "POST", body }, body);
  if (saved) form.limit.value = "";
});

document.querySelector("#card-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    name: form.name.value,
    limit: form.limit.value,
    closeDay: Number(form.closeDay.value),
    dueDay: Number(form.dueDay.value),
  };
  const saved = await mutate("/api/cards", { method: "POST", body }, body);
  if (saved) form.reset();
});

document.querySelector("#demo-button").addEventListener("click", async () => {
  state = await api("/api/demo", { method: "POST", body: {} });
  clearError();
  render();
});

document.querySelector("#reset-button").addEventListener("click", async () => {
  if (!confirm("Apagar cartões, tetos e lançamentos?")) return;
  state = await api("/api/reset", { method: "POST", body: {} });
  clearError();
  render();
});

function signature(value) {
  return JSON.stringify([
    value.demo,
    value.transactions[0]?.id ?? 0,
    value.transactions.length,
    value.monthExpenseCents,
    value.situation?.headline,
    value.situation?.score,
    value.alerts.length,
    value.cards.map((card) => card.balanceCents).join(","),
  ]);
}

function captureForms() {
  const draft = {};
  for (const form of document.querySelectorAll("form")) {
    draft[form.id] = Object.fromEntries(new FormData(form).entries());
  }
  return draft;
}

function restoreForms(draft) {
  for (const [id, values] of Object.entries(draft)) {
    const form = document.querySelector(`#${id}`);
    if (!form) continue;
    for (const [key, value] of Object.entries(values)) {
      if (form.elements[key]) form.elements[key].value = value;
    }
  }
}

try {
  state = await api("/api/state");
  render();
} catch (error) {
  showError(error);
}

setInterval(async () => {
  if (!state) return;
  try {
    const next = await api("/api/state");
    if (signature(next) === signature(state)) return;
    const draft = captureForms();
    state = next;
    render();
    restoreForms(draft);
  } catch {
    // o próximo ciclo tenta de novo
  }
}, 3000);
