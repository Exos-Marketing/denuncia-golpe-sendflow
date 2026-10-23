# SendFlow: o que o fluxo usa e o que já deu errado

Base: `https://sendflow.pro/sendapi`, cabeçalho `Authorization: Bearer <chave>`. Documentação pública em `https://sendflow.pro/sendapi/swagger.json`.

## Rotas usadas

| Rota | Corpo | Limite | Observação |
|---|---|---|---|
| `POST /block-numbers` | `{ "number": "5511912345678", "name": "..." }` | 1 s entre chamadas | põe o número no anti-spam **do usuário** (`global: false`): vale para todos os projetos da conta. Não é idempotente: repetir o mesmo número cria entrada duplicada (não faz mal) |
| `GET /block-numbers` | | 60 s entre chamadas | lista em dígitos. O fluxo não usa, para não gastar limite no caminho da denúncia |
| `POST /actions/remove-participants` | `{ releaseId, accountsFrom: "release", to: { type: "release", ids: [releaseId] }, data: { participants: [...] } }` | 5 por segundo | ação assíncrona; `to.type: "release"` atinge todos os grupos da campanha sem listar grupos. Só remove onde o chip da campanha é admin. Devolve `id` (e às vezes `actionId`) |
| `GET /actions/{actionId}` | | 1 por segundo por usuário | `processed`, `success`. Ação que falha não avisa ninguém: por isso o fluxo confere 60 s depois |
| `GET /releases` | | **1 a cada 5 minutos** | usada só no `build.py --listar-campanhas` |

Não existe rota para **desbloquear**. Desfazer um bloqueio é pelo painel do SendFlow.

## Armadilhas

- **403 "Limite de operações atingido!" é rate limit, e ele escala.** Violações repetidas em pouco tempo transformam o limite leve em chave bloqueada por horas. `GET /rate-limit/status` mostra `violationCount` e `isBlocked` sem contar como violação. Regra do fluxo: parar no primeiro 401/403.
- **Rajada em `GET /releases/{id}/groups` bloqueia a chave**, não só a campanha. Por isso a remoção usa `to.type: "release"`.
- **`GET /releases` em limite pode devolver campos `null` em vez de erro.** Lista com nome `null` não é lista vazia: espere os 5 minutos.
- **User-Agent de biblioteca é recusado pelo WAF**, e o 403 parece chave bloqueada. Mande um User-Agent de navegador (o workflow já manda).
- **Chave dedicada.** Se este fluxo esbarrar no limite com a mesma chave dos disparos, os disparos param junto.
- **Celular brasileiro tem duas grafias no WhatsApp.** Conta antiga tem o JID sem o 9 (`55 DD XXXX-XXXX`), conta nova com (`55 DD 9XXXX-XXXX`). Bloquear uma só deixa a outra passar. O fluxo bloqueia e remove as duas.
- **Não documentado:** se o número bloqueado consegue voltar ao grupo pelo link de entrada. Meça no teste real.

## Alternativas que a API oferece

- `POST /actions/find-participant { accountId, phoneNumber, timeout }` procura o número em todas as campanhas do chip e devolve os grupos (pode levar até 60 s). Útil para saber onde o golpista está antes de remover.
- O evento `release.join-request.created` + `POST /releases/{id}/join-requests/reject` permitem barrar na entrada, para grupos com aprovação de entrada.
