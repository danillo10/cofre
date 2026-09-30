# Cofre

Controle financeiro local para o OpenClaw. Três agentes olham o mesmo caixa: a Nara fecha gastos e tetos, o Vigia vigia limite e vencimento, a Luma leva a trilha de XP. O painel mostra tudo. O Telegram avisa quando um teto, um cartão ou um vencimento pede atenção.

Os números ficam em `data/cofre.sqlite`, nesta máquina.

## Painel

```bash
npm start
```

Abra http://127.0.0.1:8787

Na primeira vez entra um mês de exemplo, para os três agentes terem o que dizer. Esse exemplo não é enviado ao Telegram. Para lançar os seus números, use **Zerar** ou registre um movimento e confirme a troca.

## Agentes

| Agente | Olha para | O que rende XP |
| --- | --- | --- |
| Nara | Gastos, receitas e tetos | 12 por gasto, 18 por receita |
| Vigia | Limite, fatura e vencimento | 30 por pagamento de cartão |
| Luma | Nível, sequência, selos e desafio | 8 se lançar no mesmo dia; bônus aos 3 e aos 7 dias |

Níveis: Aprendiz do caixa, Organizador, Guardião, Estrategista, Mestre do Cofre.

O Vigia avisa quando uma categoria passa de 80% e de 100% do teto, quando um cartão passa de 30%, 50% e 70% do limite, quando a fatura vence em até 3 dias, e quando o gasto do dia dispara em relação aos 14 dias anteriores. Alerta crítico volta a ser enviado no dia seguinte se continuar valendo. A janela é 08:00–22:00, horário de São Paulo.

## Telegram

1. No Telegram, fale com o [@BotFather](https://t.me/BotFather), use `/newbot` e guarde o token.
2. Descubra o seu id numérico com o [@userinfobot](https://t.me/userinfobot).
3. Copie `.env.example` para `.env` e preencha `TELEGRAM_BOT_TOKEN`. O `TELEGRAM_CHAT_ID` é opcional: na primeira mensagem privada o Cofre grava a conversa. Reinicie com `npm start`.

Com o token e `OPENAI_API_KEY` ativos, o Cofre entende linguagem natural, responde perguntas sobre o seu cenário e transforma textos ou fotos em lançamentos:

- `42,90 almoço`
- `gastei 80 no mercado`
- `ontem eu gastei quarenta reais no almoço`
- `como está minha situação este mês?`
- `recebi 5200 de salário`
- `paguei 200 no Nubank`
- foto do cupom, de preferência com a palavra TOTAL visível; se a leitura falhar, escreva o valor na legenda

A Nara responde com o valor lançado e com a situação (sob controle, apertando, piorando ou fora de controle). O painel em http://127.0.0.1:8787 atualiza sozinho. Enquanto o mês de exemplo estiver na tela, responda `SIM` para zerar e lançar de verdade.

A foto é enviada à visão da IA junto com o texto extraído pelo Tesseract. Ela identifica total, data, categoria e parcelamento. Uma compra parcelada gera um lançamento por mês, numerado como `parcela 1/N`, preservando o valor total. Sem IA ou OCR, a legenda da foto ainda vale.

O mesmo token não pode ficar ao mesmo tempo no gateway do OpenClaw: os dois disputariam as mensagens. Use este bot para lançar. Se quiser conversar com o OpenClaw, crie um segundo bot.

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

O arquivo `openclaw.example.json5` aponta os workspaces deste projeto, liga o bot ao agente Cofre e deixa Nara, Vigia e Luma como especialistas. A checagem automática está a cada 2 horas, no horário comercial. O texto pronto para o monitor está em `workspace/MONITOR.txt`.

```bash
openclaw config set commands.ownerAllowFrom '["telegram:SEU_ID"]'
openclaw gateway restart
openclaw agents list --bindings
```

No privado deste bot, o lançamento é direto: texto ou foto viram um movimento. O OpenClaw, se você usar outro bot, continua podendo consultar o caixa com `bin/cofre state`.

## Comandos

```bash
bin/cofre state --json
bin/cofre add expense 42,90 alimentacao --note "almoço"
bin/cofre add income 5200 salario
bin/cofre add payment 200 Nubank
bin/cofre card add Nubank --limit 4000 --close 3 --due 10
bin/cofre budget set alimentacao 600
bin/cofre pending --json
bin/cofre watch
npm run check
```

`npm run check` confere o motor sem abrir o painel.
