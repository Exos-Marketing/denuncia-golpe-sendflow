# Contrato HTTP

Para portar o site a outra stack (Express, PHP, WordPress, Cloudflare Worker, Laravel...). O workflow do n8n é o mesmo; só a página e a rota mudam. A implementação de referência está em `site/nextjs/`.

## 1. Página → rota do seu site

`POST /api/denuncia-golpe/` com `Content-Type: application/json`

```json
{
  "suspeito": "+5511912345678",
  "nome": "Maria Souza",
  "whatsapp": "+5521998765432",
  "link": "https://link-que-o-golpista-mandou",
  "relato": "Ofereceu desconto e pediu Pix",
  "print": "data:image/jpeg;base64,/9j/4AAQ...",
  "empresa": ""
}
```

| Campo | Regra |
|---|---|
| `suspeito` | obrigatório, E.164 (`+` e 8 a 15 dígitos; no Brasil, DDD + 8 ou 9 dígitos, celular começa com 9) |
| `nome` | obrigatório, 2 a 80 caracteres |
| `whatsapp` | obrigatório, E.164, diferente de `suspeito` |
| `link`, `relato` | opcionais, cortados em 500 caracteres |
| `print` | opcional, data URL `image/jpeg`, `image/png` ou `image/webp`, até ~2,8 MB em base64. Reduza no navegador (lado maior até 1600 px) antes de enviar |
| `empresa` | campo isca, escondido. Veio preenchido: responda `200 {"ok":true,"status":"pausado"}` e descarte |

Respostas da rota:

| HTTP | Corpo | Quando |
|---|---|---|
| 200 | `{"ok":true,"status":"oficial","papel":"Suporte oficial"}` | número da equipe; não chama o n8n |
| 200 | `{"ok":true,"status":"bloqueado" \| "repetido" \| "pausado"}` | repassado ao n8n |
| 400 | `{"ok":false,"field":"suspeito","error":"..."}` | campo inválido (`field` aponta qual) |
| 429 | `{"ok":false,"error":"..."}` | mais de 5 denúncias válidas do mesmo IP na última hora |
| 502 | `{"ok":false,"error":"..."}` | o n8n não respondeu depois de 3 tentativas; registre a denúncia no log |

Conte no limite por IP só a denúncia que passou na validação. Atrás de proxy, o IP real vem no primeiro valor de `X-Forwarded-For`.

## 2. Rota → webhook do n8n

`POST <GOLPE_WEBHOOK_URL>` com os cabeçalhos `Content-Type: application/json` e `X-Webhook-Token: <GOLPE_WEBHOOK_TOKEN>`. Timeout de 8 s por tentativa, até 3 tentativas, e **não repita em 403** (é o token errado). Em serverless, deixe a função durar pelo menos 30 s.

```json
{
  "client": "minha-marca",
  "dry": false,
  "suspeito": "+5511912345678",
  "denunciante": { "nome": "Maria Souza", "whatsapp": "+5521998765432" },
  "link": "https://link-que-o-golpista-mandou",
  "relato": "Ofereceu desconto e pediu Pix",
  "print": { "mime": "image/jpeg", "base64": "/9j/4AAQ..." },
  "page": "/denunciar-golpe/",
  "ip": "203.0.113.7",
  "ua": "Mozilla/5.0 ...",
  "receivedAt": "2026-10-23T13:00:00.000Z"
}
```

- `client` é o slug em `clientes` do `config.json`.
- `dry: true` faz o workflow não chamar o SendFlow, não mexer na memória e mandar o e-mail como `[TESTE]`.
- `print`, `link` e `relato` podem ser `null`.

Resposta do n8n (sai antes de qualquer chamada ao SendFlow):

```json
{ "ok": true, "status": "bloqueado" }
```

| status | Significado | Mensagem sugerida para a pessoa |
|---|---|---|
| `bloqueado` | vai bloquear e tirar dos grupos agora | "Esse número está sendo bloqueado e retirado dos nossos grupos." |
| `repetido` | já foi bloqueado por outra denúncia recente | "Esse número já tinha sido denunciado e já está sendo bloqueado." |
| `oficial` | número da equipe, não bloqueia | "Esse número é da nossa equipe." |
| `pausado` | não bloqueou sozinho (modo aprovação, disjuntor, marca desconhecida, dado inválido) | "Recebemos sua denúncia. A equipe vai conferir." |

Sem o cabeçalho certo o n8n responde `403` sozinho.
