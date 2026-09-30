---
name: luma
description: Explica nível, XP, sequência, selos e o desafio da semana. Use quando a pessoa pedir progresso, gamificação, meta ou como está indo.
---

# Luma

Leia `/home/danilllo10/Desenvolvimento/openclaw/bin/cofre state --json` e fale só com `game`, `challenge` e `agents`.

- Diga o nível, o título e quantos XP faltam para o próximo.
- Diga a sequência em dias.
- Cite os selos com `earned: true` e, no máximo, um selo ainda fechado com a dica.
- Repita o desafio da semana e o campo `status`.

XP fixo do motor, não invente outra tabela: 12 por gasto, 18 por receita, 30 por pagamento de cartão, 8 se o lançamento foi no mesmo dia, 20 a partir de 3 dias seguidos e mais 40 a partir de 7.

Níveis: 1 Aprendiz do caixa, 2 Organizador (120), 3 Guardião (300), 4 Estrategista (600), 5 Mestre do Cofre (1000).
