# CLAUDE.md

Instruções para o agente (Claude Code) que vai instalar, adaptar ou manter este projeto.

## O que é

Uma página de denúncia de golpista + um workflow n8n. Quem foi abordado no privado por alguém se passando pela marca manda o número; o n8n bloqueia esse número no SendFlow, tira dos grupos de WhatsApp das campanhas da marca e manda um e-mail de conferência para a equipe. Visão geral para humanos no [README](README.md).

| Peça | Onde | O que faz |
|---|---|---|
| Página | `site/nextjs/app/denunciar-golpe/` + `components/denuncia/` | formulário (número, print opcional, nome e WhatsApp de quem denuncia) |
| Rota | `site/nextjs/app/api/denuncia-golpe/route.ts` | valida, limita por IP, filtra número oficial, repassa ao n8n |
| Config do site | `site/nextjs/lib/denuncia-golpe.ts`, `lib/numeros-oficiais.ts` | marca, cores, links, slug, números da equipe |
| Workflows | `n8n/decide.js`, `remocao.js`, `email.js` + `n8n/build.py` | principal (Webhook, Decide, Responde, Executa), `<nome>-execucao` (bloqueio, remoção, conferência, e-mail) e `<nome>-alerta` (e-mail se algum dos dois falhar). Testado no n8n 2.10 |
| Config do workflow | `n8n/config.json` (fora do git; modelo em `config.example.json`) | campanhas, protegidos, e-mail, limites, ids de credencial |

## Para instalar ou adaptar

Siga a skill [`.claude/skills/denuncia-golpe/SKILL.md`](.claude/skills/denuncia-golpe/SKILL.md). Ela tem a ordem certa, o que perguntar ao humano e como testar. Não pule para o passo do site antes de o workflow estar publicado e testado em modo seco.

Site que não é Next.js: implemente o contrato de [`docs/contrato.md`](docs/contrato.md) na stack da pessoa (Express, PHP, WordPress, Cloudflare Worker...). O workflow não muda.

## Regras que não se quebram

**O bloqueio é real, vale para a conta inteira do SendFlow e não tem desfazer pela API.** Por isso:

1. **A lista de protegidos precisa estar completa antes do primeiro push.** Peça ao humano todos os números da equipe: suporte, comercial, chips de disparo, admins dos grupos, número da API oficial do WhatsApp, o próprio expert. Número de equipe fora da lista pode ser bloqueado por uma denúncia falsa. Na dúvida, inclua: protegido a mais só deixa de ser bloqueado sozinho (o e-mail chega igual).
2. **Primeiro teste sempre em modo seco** (`GOLPE_DRY_RUN=1` no site, ou `"dry": true` no corpo do webhook). O teste real é feito com um número reserva que a própria equipe controla, nunca com número inventado (ele pode existir e ser de alguém).
3. **Publique primeiro em modo aprovação** (`"bloqueio_automatico": false`, o padrão do exemplo) e **confirme com o humano antes de qualquer escrita real no SendFlow**: ligar o bloqueio automático, o teste real e qualquer bloqueio manual. Teste de número protegido também é com `dry: true`.
4. **Segredos nunca vão para o git nem para a resposta**: `n8n/config.json`, `n8n/.segredos/`, `n8n/workflow.json` e `.env*` estão no `.gitignore`. Chaves entram por variável de ambiente ou direto na credencial do n8n. Não imprima o valor de token nenhum.
5. **Edite o JS em `n8n/*.js` e rode `build.py --push`.** Edição feita no editor do n8n é sobrescrita no próximo push.

## Regras da SendAPI (medidas em produção)

Resumo do que já derrubou chave e fluxo; detalhes em [`docs/sendflow.md`](docs/sendflow.md):

- `403 "Limite de operações atingido!"` é rate limit. Violações repetidas em poucos minutos bloqueiam a **chave inteira** por horas. Pare no primeiro 403, não repita em laço. O workflow já faz isso.
- `GET /releases` aceita uma chamada a cada **5 minutos** e, em limite, pode devolver campos `null` em vez de erro. Use `build.py --listar-campanhas` uma vez e guarde o resultado.
- Nunca chame `GET /releases/{id}/groups` em rajada (bloqueia a chave). A remoção usa `to.type: "release"` justamente para não precisar listar grupos.
- Mande `User-Agent` de navegador: o WAF recusa o de biblioteca, e o 403 parece chave bloqueada.
- Use uma chave **dedicada** a este fluxo, para um problema aqui não parar os disparos.

## Como o workflow decide

`Decide` classifica cada denúncia antes de chamar o SendFlow:

| status | quando | o que acontece |
|---|---|---|
| `oficial` | número na lista de protegidos | nada no SendFlow; e-mail avisa |
| `repetido` | mandado bloquear há menos de `repetido_minutos` | nada no SendFlow; e-mail conta a enésima denúncia |
| `pausado` | marca desconhecida, número inválido, modo aprovação ou disjuntor | nada no SendFlow; e-mail pede ação manual |
| `bloqueado` | o resto | bloqueia as grafias, remove de cada campanha, confere, e-mail com o resultado |

A memória (quem já foi denunciado, bloqueios da última hora) fica no `staticData` do workflow principal e só é gravada quando a execução termina. Por isso o principal faz só Webhook, Decide, Responde e Executa (milissegundos) e chama o de execução sem esperar: se o trabalho pesado rodasse nele, denúncias simultâneas não se enxergariam e o disjuntor não seguraria uma rajada. Não junte os dois de volta. Resta uma janela de milissegundos: duas denúncias no mesmo instante ainda podem não se enxergar, o que é aceitável para o disjuntor. Se o SendFlow recusar um bloqueio, o e-mail avisa e a próxima denúncia depois da janela de `repetido_minutos` tenta de novo.

## Manutenção

- **Número novo na equipe**: entra em `protegidos` (e em `site/.../lib/numeros-oficiais.ts`) + `build.py --push`, no mesmo dia.
- **Campanha nova**: uma linha em `clientes.<slug>.releases` + `build.py --push`.
- **Outra marca no mesmo n8n**: novo bloco em `clientes` e a página no site dela com `GOLPE_CLIENT` igual ao slug. Mesmo workflow, mesmo segredo.

## Verificação antes de dizer que terminou

São dois estados de entrega, diga qual é:

- **No ar em modo aprovação:** todos os itens abaixo, menos o teste real. Toda denúncia vira e-mail e a equipe bloqueia à mão. É uma entrega válida e parcial.
- **Pronto:** bloqueio automático ligado com a confirmação do humano e teste real feito.

- `python3 n8n/build.py` imprime a lista de protegidos: revise com o humano.
- Webhook sem o cabeçalho responde `403`; com ele e `dry: true` responde `pausado` em modo aprovação ou `bloqueado` no automático, e chega e-mail `[TESTE]`.
- Número protegido, com `dry: true`, responde `oficial`.
- A página carrega no celular sem rolagem horizontal, envia com e sem print e mostra a confirmação.
- Teste real com número reserva: bloqueado nas duas grafias, removido do grupo, ação com `success: true`, segunda denúncia responde `repetido`. Desbloqueie no painel depois.
