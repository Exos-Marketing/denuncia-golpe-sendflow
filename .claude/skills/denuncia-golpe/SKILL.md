---
name: denuncia-golpe
description: Use quando alguém pedir para instalar, adaptar, testar ou manter a denúncia de golpista com bloqueio no SendFlow (repo denuncia-golpe-sendflow), ou quando golpistas estiverem chamando no privado os participantes dos grupos de WhatsApp de um lançamento e a pessoa quiser uma página de denúncia, bloquear números em massa, tirar golpista dos grupos, ou adicionar número de equipe ou campanha nova ao fluxo.
---

# Denúncia de golpe com bloqueio no SendFlow

## Visão geral

Página de denúncia no site → rota do site → workflow n8n principal (decide e responde em menos de 1 s) → workflow n8n de execução (bloqueia no SendFlow, tira dos grupos, confere, manda e-mail). Mapa dos arquivos e regras no `CLAUDE.md` da raiz do repositório.

**Princípio:** o bloqueio é real, vale para a conta inteira do SendFlow e não se desfaz pela API. A ordem abaixo existe para que nenhum número de verdade seja bloqueado antes de a lista de protegidos estar completa e de o fluxo ter passado no teste seco. Prazo apertado não muda a ordem: se não der tempo de terminar, entregue **no ar em modo aprovação** (só e-mail, nada bloqueado sozinho) e diga que é entrega parcial; "pronto" é com o automático ligado e o teste real feito.

## Ordem de instalação

### 1. Perguntar ao humano (tudo de uma vez)

| Pergunta | Vai para |
|---|---|
| Caminho do site, stack, App Router ou Pages Router, se usa `src/`, alias `@/`, `trailingSlash`, `basePath`/i18n | passo 6 (Next.js App Router copia `site/nextjs/`; Pages Router e outras stacks seguem `docs/contrato.md`) |
| Onde o site roda em produção (Vercel, Coolify, servidor próprio) | passo 7 (variáveis de ambiente) |
| Nome da marca, cores, link do suporte oficial, link da política de privacidade, página de verificação de número (se tiver) | `lib/denuncia-golpe.ts` |
| **Todos** os números da equipe: suporte, comercial, chips de disparo, admins dos grupos, número da API oficial do WhatsApp, o próprio expert, de todos os projetos da conta SendFlow | `protegidos` no `config.json` e `lib/numeros-oficiais.ts` |
| E-mail que recebe as denúncias e um remetente que o SMTP aceite | `email_para`, `email_de` |
| URL do n8n e a chave da API do n8n | env `N8N_API_BASE`, `N8N_API_KEY` |
| Uma chave da SendAPI **só para este fluxo** e o `projectId` do SendFlow | env `SENDFLOW_API_KEY`; `--listar-campanhas` |
| Credencial SMTP existente no n8n (id) ou dados para criar | `credenciais.smtp` |
| Depois dos testes: bloqueio automático ou continuar em modo aprovação? | `bloqueio_automatico` |
| Um número reserva da equipe, fora dos protegidos, para o teste real | passo 8 |

Pergunte pelos números de todos os projetos, porque o bloqueio vale para a conta inteira. `protegidos_arquivos` (aceita glob) lê **todo** telefone de cada arquivo: aponte só para arquivo que lista números da equipe, nunca para um que também liste golpistas conhecidos.

### 2. Configurar o workflow

```bash
cp n8n/config.example.json n8n/config.json
python3 n8n/build.py --listar-campanhas <projectId>   # UMA vez: GET /releases é 1 chamada a cada 5 min
```

Cole o resultado em `clientes.<slug>.releases`. O `<slug>` é o mesmo valor da constante `GOLPE_CLIENT` em `lib/denuncia-golpe.ts` do site. Se vier campanha com nome `null`, é rate limit: espere 5 minutos, não repita em seguida. Deixe `"bloqueio_automatico": false` (é o padrão do exemplo).

### 3. Credenciais

```bash
python3 n8n/build.py --criar-credenciais
```

Cria a do webhook (segredo em `n8n/.segredos/webhook-token`) e a do SendFlow, e grava os ids no `config.json`. SMTP: id da credencial existente, ou `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`.

### 4. Gerar, revisar com o humano, publicar em modo aprovação

```bash
python3 n8n/build.py          # imprime a lista de protegidos com a origem de cada número
```

Mostre a lista ao humano e peça confirmação de que está completa. O build avisa, e o `--push` recusa, enquanto houver número, campanha ou e-mail de exemplo. Depois:

```bash
python3 n8n/build.py --push   # publica principal, execução e alerta; em modo aprovação nada é bloqueado
```

### 5. Teste seco no webhook

```bash
URL=https://<n8n>/webhook/<webhook_path>; T=$(cat n8n/.segredos/webhook-token)
curl -s -o /dev/null -w "%{http_code}\n" -X POST $URL -d '{}'                         # 403
curl -s -X POST $URL -H "X-Webhook-Token: $T" -H 'Content-Type: application/json' \
  -d '{"client":"<slug>","dry":true,"suspeito":"+5511912345678","denunciante":{"nome":"Teste","whatsapp":"<número da equipe>"}}'
curl -s -X POST $URL -H "X-Webhook-Token: $T" -H 'Content-Type: application/json' \
  -d '{"client":"<slug>","dry":true,"suspeito":"<um protegido>","denunciante":{"nome":"Teste","whatsapp":"<número da equipe>"}}'
```

Esperado: `403`; `pausado` (modo aprovação) com e-mail `[TESTE]`; `oficial` com e-mail "oficial, NÃO bloqueado". Todo teste deste passo é com `"dry": true`. Se vier `pausado` com motivo diferente de "modo aprovação", leia o motivo no nó Decide (o mais comum é slug que não casa).

Com a confirmação do humano, ligue `"bloqueio_automatico": true`, rode `build.py --push` e repita o teste seco do número comum: agora ele responde `bloqueado`, e o e-mail `[TESTE]` diz "nada feito no SendFlow".

### 6. Site

- Next.js: copie `site/nextjs/app/*`, `components/denuncia/` e `lib/*` para dentro do `app/`, `components/` e `lib/` do projeto (ou de `src/`, se ele usar). Se o alias não for `@/`, ajuste os imports. `npm i react-phone-number-input`. Requer Tailwind v3.2+ ou v4.
- Ajuste `lib/denuncia-golpe.ts` (`GOLPE_CLIENT`, `MARCA`, `CORES`, `rastrearSuporte`) e `lib/numeros-oficiais.ts`.
- `trailingSlash: false` no `next.config`: tire a barra final de `DENUNCIA_PATH`, de `DENUNCIA_API`, do link `?n=` e dos links que você divulgar (os exemplos dos docs usam barra). Com `basePath`, prefixe `DENUNCIA_API` com ele.
- A página já sai com `noindex`. Deixe-a **fora do sitemap** e **não** ponha `Disallow` no robots para ela: rota bloqueada não é rastreada, o Google nunca lê o `noindex` e a URL pode ser indexada por link externo. Se já existir `robots.ts`, só confira que ele não bloqueia a rota.
- Sem `<form>` e sem pixel `Lead` na página: está explicado no topo do componente.
- Env local para teste: `GOLPE_WEBHOOK_URL`, `GOLPE_WEBHOOK_TOKEN` (o conteúdo de `n8n/.segredos/webhook-token`), `GOLPE_DRY_RUN=1`.
- Rode o lint e o build do projeto, abra a página a 390 px de largura e siga `docs/testes.md` (seção do site).

### 7. Produção

- As três variáveis vão no painel do serviço onde o site roda (Vercel, Coolify, Netlify, `.env` do servidor), só no servidor, nunca como `NEXT_PUBLIC_`. Comece com `GOLPE_DRY_RUN=1`.
- Deploy. Denuncie pela página publicada e confira o e-mail `[TESTE]`. Tire `GOLPE_DRY_RUN` e faça novo deploy.
- Serverless (Vercel, Netlify): a rota já declara `maxDuration = 30`; o limite por IP é por instância e some no cold start, então ali ele é só um freio (o disjuntor do n8n é quem segura rajada).
- Para desligar às pressas: `"bloqueio_automatico": false` + `build.py --push` (segundos, sem mexer no site).

### 8. Teste real (com confirmação do humano)

Com o número reserva: entrar num grupo da campanha, denunciar pela página, conferir na execução do workflow `<nome>-execucao` que as duas grafias responderam 200 e que `Confere` voltou `success: true`, ver que saiu do grupo. Denunciar o mesmo número de novo: responde `repetido`. Tentar voltar pelo link de entrada e anotar se o bloqueio impede. No fim, desbloquear no painel do SendFlow (anti-spam). A marca de "repetido" expira sozinha em `repetido_minutos`.

### 9. Divulgar (só depois do teste real)

Textos de `docs/divulgacao.md`: descrição dos grupos, boas-vindas, página de obrigado. Agendar mensagem nos grupos é disparo: só com confirmação.

## Manutenção

| Pedido | Faça |
|---|---|
| número novo na equipe | `protegidos` + `lib/numeros-oficiais.ts` + `build.py --push` no mesmo dia |
| campanha nova | linha em `clientes.<slug>.releases` + `build.py --push` |
| outra marca | novo bloco em `clientes` + página no site dela com `GOLPE_CLIENT` igual ao slug |
| desfazer um bloqueio | painel do SendFlow (anti-spam). A API não desbloqueia |
| mudar texto do e-mail ou regra | editar `n8n/*.js` + `build.py --push`, nunca o editor do n8n |
| sem n8n API | importe `workflow-execucao.example.json` primeiro e publique; importe `workflow.example.json`, ponha o id do primeiro no nó **Executa**, escolha as credenciais e edite o `CFG` no nó **Decide** |

## Erros comuns

| Sintoma | Causa |
|---|---|
| webhook responde 404 | workflow principal inativo: rode `--push` de novo (ele desativa e reativa) |
| `--push` falha com "publish all referenced sub-workflows first" | o de execução não ficou ativo; rode `--push` de novo |
| site responde 502 | `GOLPE_WEBHOOK_URL`/`GOLPE_WEBHOOK_TOKEN` faltando ou token diferente do da credencial; veja `LOST_REPORT` no log |
| status `pausado`, motivo "cliente desconhecido" | constante `GOLPE_CLIENT` do site diferente do slug em `clientes` |
| site responde, mas não chega e-mail | erro no workflow de execução (deveria chegar o e-mail de alerta; veja as execuções) ou SMTP recusou o remetente |
| `--push` recusa com "valores de exemplo" | troque os números, a campanha e o e-mail de exemplo no `config.json` |
| `--push` falhou no meio | a versão anterior foi reativada; o backup está em `n8n/.backup/` |
| e-mail diz bloqueio 401 | chave do SendFlow errada na credencial |
| e-mail diz bloqueio 403 | rate limit ou WAF; o fluxo já parou, não insista. Espere e confira `GET /rate-limit/status` |
| remoção com `success: false` | chip não é admin daquele grupo, ou campanha errada |

## Sinais de que você está pulando etapa

- "Ligo o bloqueio automático agora e completo a lista de protegidos depois."
- "Testo o protegido com `dry: false`, é só para ver."
- "Testo direto com um número qualquer, é só um teste."
- "Uso a chave principal do SendFlow, é mais rápido."
- "Chamo o `/releases` de novo, deu null."
- "Ajusto o código direto no editor do n8n."

Todos levam ao mesmo lugar: número de verdade bloqueado na conta inteira, ou chave bloqueada no meio do lançamento. Volte à ordem acima.
