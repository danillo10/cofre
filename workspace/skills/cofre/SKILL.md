---
name: cofre
description: Registra e consulta gastos, receitas, tetos e o resumo do mês no Cofre. Use quando a pessoa falar de dinheiro, gasto, salário, orçamento, saldo ou lançamento.
---

# Cofre

Texto e foto que chegam no Telegram já são lançados pelo Cofre. Antes de registrar de novo, rode `state --json` para não duplicar. Se o usuário mandou "42,90 almoço" ou uma foto, o movimento pode já estar na lista com `source: "telegram"`.

## Consultar

- `state --json` — painel inteiro: caixa, mês, cartões, tetos, alertas, XP e falas dos agentes.
- `summary` — texto curto para ler em voz alta.
- `alerts --json` — alertas ativos agora.
- `pending --json` — só o que ainda não foi enviado. Se vier `[]`, responda `NO_REPLY` numa checagem automática.

## Registrar

```bash
bin/cofre add expense 42,90 alimentacao --note "almoço" --card Nubank
bin/cofre add income 5200 salario --note "salário"
bin/cofre add payment 200 Nubank --note "parte da fatura"
bin/cofre card add Nubank --limit 4000 --close 3 --due 10
bin/cofre budget set alimentacao 600
```

Categorias de gasto: alimentacao, mercado, transporte, moradia, lazer, saude, assinaturas, educacao, outros.
Categorias de receita: salario, freelance, outros.
Dia de fechamento e vencimento: 1 a 28.

Depois de lançar, leia `state --json` de novo e responda com o efeito: saldo do mês, teto da categoria e, se houver cartão, a fatura.
