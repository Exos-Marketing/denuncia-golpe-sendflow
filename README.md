# Denúncia de golpe · bloqueio automático no SendFlow

Em lançamento com grupo de WhatsApp, golpista entra no grupo, copia a lista de participantes e chama cada pessoa no privado se passando pelo expert ou pela equipe: oferece desconto, vaga, bolsa, e pede Pix. Quem administra os grupos fica sabendo tarde, bloqueia um número por vez à mão, e o golpista volta com outro.

Este repositório resolve isso com uma página de denúncia. Quem foi abordado cola o número do golpista (e, se quiser, um print da conversa) e envia. O número é **bloqueado no SendFlow e retirado de todos os grupos das suas campanhas sozinho**, e a equipe recebe um **e-mail de conferência** com os links para falar com quem denunciou e para ver o perfil do número denunciado.

Feito pela [Exos](https://exosmkt.com.br) para os lançamentos da agência e aberto para você adaptar à sua estrutura. Funciona com o [Claude Code](https://code.claude.com/docs): o repositório traz as instruções para o agente fazer a adaptação com você.

## Como funciona

```
pessoa abordada
└─ /denunciar-golpe/        número do golpista, print opcional, nome e WhatsApp de quem denuncia
   └─ /api/denuncia-golpe/  valida, limita por IP; número da equipe responde "oficial" e para aqui
      └─ workflow n8n principal (exige o cabeçalho X-Webhook-Token)
         ├─ Decide           protegido? repetido? disjuntor? responde ao site na hora
         └─ chama, sem esperar, o workflow de execução
            ├─ SendFlow      bloqueia (com e sem o 9), remove de cada campanha, confere em 60s
            └─ e-mail        para a equipe: wa.me dos dois, print, resultado, como desfazer
```

O site responde à pessoa em menos de 2 segundos. São dois workflows de propósito (mais um terceiro, de alerta, que manda e-mail se algum deles falhar): o principal termina em milissegundos, então a memória dele (quem já foi denunciado, quantos bloqueios na última hora) é gravada na hora e denúncias simultâneas se enxergam. O bloqueio, a remoção, a conferência e o e-mail ficam no segundo.

## Travas contra denúncia falsa

Bloqueio automático é rápido, mas uma denúncia de má-fé poderia tirar dos grupos uma aluna real ou até o seu suporte. Por isso:

- **Números protegidos nunca são bloqueados**: suporte, comercial, chip de disparo, admins dos grupos. A lista fica no `config.json`.
- **Disjuntor**: a partir de 10 bloqueios na mesma hora, o fluxo para de bloquear e só manda e-mail.
- Número mandado bloquear há menos de uma hora (`repetido_minutos`) não chama o SendFlow de novo.
- No máximo 5 denúncias por IP por hora, e um campo isca contra robô.
- O webhook do n8n só aceita chamadas com um segredo no cabeçalho.
- **Toda** denúncia gera e-mail, inclusive as que não bloquearam. Se um workflow quebrar no meio, o workflow de alerta avisa a equipe por e-mail.
- O exemplo nasce em **modo aprovação** (`"bloqueio_automatico": false`): nada é bloqueado sozinho até você testar e ligar o automático. Quem prefere conferir cada denúncia antes pode deixar assim.

## O que você precisa

- **SendFlow** com acesso à SendAPI. Gere uma chave **só para este fluxo**: se ele esbarrar no limite da API, não derruba os seus disparos.
- **n8n 2.x** (testado no 2.10, self-hosted ou cloud) com a API habilitada, e uma credencial SMTP para mandar o e-mail.
- **Um site com backend.** O exemplo pronto é para Next.js (App Router) com Tailwind. Para outra stack, o contrato HTTP está em [`docs/contrato.md`](docs/contrato.md).
- Python 3.9+ para rodar o `build.py` (só biblioteca padrão).

## Jeito mais rápido: com o Claude Code

Clone o repositório, abra o Claude Code dentro dele e peça:

```
Instala a denúncia de golpe no meu site, que está em ../meu-site.
```

O `CLAUDE.md` e a skill em [`.claude/skills/denuncia-golpe/`](.claude/skills/denuncia-golpe/SKILL.md) guiam o agente: ele pergunta o que precisa (marca, campanhas, números da equipe, e-mail), monta a configuração, publica o workflow, instala a página e testa tudo sem efeito no SendFlow antes do teste real.

Para usar a skill de dentro do repositório do seu site, copie a pasta `.claude/skills/denuncia-golpe/` para o `.claude/skills/` do seu projeto e aponte o agente para este repositório.

## Passo a passo manual

1. **Configuração.** `cp n8n/config.example.json n8n/config.json` e preencha: e-mail de destino, nome da marca, números protegidos. O `config.json` fica fora do git.
2. **Variáveis de ambiente** no terminal: `N8N_API_BASE` (ex.: `https://n8n.suaempresa.com/api/v1`), `N8N_API_KEY` e `SENDFLOW_API_KEY`.
3. **Campanhas.** `python3 n8n/build.py --listar-campanhas <projectId>` lista as campanhas de grupo ativas do projeto, prontas para colar em `clientes.<slug>.releases`. O SendFlow aceita essa consulta uma vez a cada 5 minutos.
4. **Credenciais.** `python3 n8n/build.py --criar-credenciais` cria no n8n a do webhook (com segredo gerado na hora, salvo em `n8n/.segredos/`) e a do SendFlow. A de SMTP você cria no painel do n8n e cola o id, ou passa `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` e `SMTP_PASSWORD`.
5. **Publicar em modo aprovação.** `python3 n8n/build.py --push` gera e ativa os três workflows (ele recusa enquanto o config tiver valor de exemplo e guarda backup do que sobrescrever em `n8n/.backup/`). Confira a lista de números protegidos que ele imprime. Depois dos testes secos, mude `bloqueio_automatico` para `true` e rode `--push` de novo.
6. **Site.** Copie `site/nextjs/` para o seu projeto, ajuste `lib/denuncia-golpe.ts` (marca, cores, links, slug) e `lib/numeros-oficiais.ts`, instale `react-phone-number-input` e defina no servidor `GOLPE_WEBHOOK_URL` e `GOLPE_WEBHOOK_TOKEN`. A página já sai com `noindex`: deixe fora do sitemap e **sem** `Disallow` no robots (rota bloqueada não é rastreada, e aí o Google nunca lê o `noindex`).
7. **Testar** seguindo [`docs/testes.md`](docs/testes.md): primeiro com `GOLPE_DRY_RUN=1`, depois um teste real com um número reserva da equipe.
8. **Divulgar** o link no onboarding dos grupos: textos prontos em [`docs/divulgacao.md`](docs/divulgacao.md).

Sem n8n API? Pelo painel do n8n, importe `n8n/workflow-alerta.example.json` e `n8n/workflow-execucao.example.json` e publique o de execução; depois importe `n8n/workflow.example.json`, ponha o id do de execução no nó **Executa**, aponte o error workflow dos dois para o de alerta (Settings do workflow), escolha as credenciais e edite o bloco `CFG` no nó **Decide**. Só lembre que o `build.py` é o caminho para manter a lista de protegidos em dia.

## Limites que você precisa conhecer

- **O bloqueio vale para a conta inteira do SendFlow**, todos os projetos. Um número bloqueado a partir da página de uma marca também fica bloqueado nas outras.
- **A SendAPI não tem desbloqueio.** Desfazer é no painel do SendFlow (anti-spam, números bloqueados). O e-mail de conferência traz o passo a passo.
- A remoção só funciona nos grupos em que o chip da campanha é admin.
- Celular brasileiro existe com e sem o 9 no WhatsApp: o fluxo bloqueia e remove as duas grafias.
- A documentação do SendFlow não diz se o bloqueio impede a pessoa de voltar ao grupo pelo link de entrada. Meça no seu teste real (o passo está em `docs/testes.md`).
- Os limites de uso da SendAPI e as armadilhas que medimos estão em [`docs/sendflow.md`](docs/sendflow.md).

## Estrutura

```
CLAUDE.md                         instruções para o agente
.claude/skills/denuncia-golpe/    skill de instalação e manutenção
n8n/
  build.py                        gera, cria credenciais, lista campanhas, publica
  decide.js remocao.js email.js   código dos nós Code (edite aqui, não no n8n)
  config.example.json             modelo do config.json
  workflow.example.json           workflow principal pronto para importar pelo painel
  workflow-execucao.example.json  workflow de execução (importe e publique primeiro)
  workflow-alerta.example.json    error workflow: e-mail se algum dos dois falhar
site/nextjs/                      página, rota da API e libs para Next.js
docs/                             contrato HTTP, SendFlow, testes, divulgação
```

## Licença

MIT. Use, adapte e redistribua. O fluxo bloqueia números de verdade numa conta de verdade: teste em modo seco primeiro e mantenha a lista de protegidos completa. Projeto independente, sem vínculo com o SendFlow ou o n8n.
