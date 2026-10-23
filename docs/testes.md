# Testes

Na ordem. Os passos 1 a 5 não tocam no SendFlow.

## 1. Build

```bash
python3 n8n/build.py
```

Confira a lista de protegidos impressa: todo número da equipe precisa estar lá, com a origem certa.

## 2. Webhook sem o segredo

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<n8n>/webhook/<webhook_path> -d '{}'
```

Esperado: `403`. Se vier `404`, o workflow não está ativo: rode `build.py --push` de novo.

## 3. Teste seco

```bash
T=$(cat n8n/.segredos/webhook-token)
curl -s -X POST https://<n8n>/webhook/<webhook_path> \
  -H "X-Webhook-Token: $T" -H 'Content-Type: application/json' \
  -d '{"client":"<slug>","dry":true,"suspeito":"+5511912345678","denunciante":{"nome":"Teste","whatsapp":"<número da equipe>"}}'
```

Esperado: em modo aprovação, `{"ok":true,"status":"pausado"}` e e-mail `[TESTE] ... NÃO bloqueado, conferir à mão (modo aprovação...)`; com o bloqueio automático ligado, `bloqueado` e e-mail `[TESTE] ... teste, nada feito no SendFlow`. Na execução do workflow `<nome>-execucao`, nenhum nó do SendFlow rodou.

## 4. Número protegido

O mesmo comando, ainda com `"dry": true`, e `"suspeito"` igual a um número da lista. Esperado: `oficial` e e-mail "oficial, NÃO bloqueado". Não teste protegido com `dry: false`: se a lista estiver errada, o número da equipe é bloqueado na conta inteira.

## 5. Site em modo seco

Local, com `GOLPE_DRY_RUN=1`:

- envio sem nome e sem WhatsApp mostra os erros nos campos;
- o próprio número no campo do golpista é recusado;
- um número de `lib/numeros-oficiais.ts` responde "Esse número é da nossa equipe" sem chamar o n8n;
- um número comum, com print, responde "Denúncia recebida" e chega o e-mail `[TESTE]` com o print anexado;
- o 6º envio válido do mesmo IP na mesma hora responde 429;
- no celular (largura 390 px) não há rolagem horizontal.

Repita o teste seco no site publicado antes de tirar o `GOLPE_DRY_RUN`.

## 6. Teste real (combine com a equipe antes)

Use um número reserva que a equipe controla e que **não** esteja nos protegidos. Nunca um número inventado: ele pode existir e ser de alguém.

1. O número reserva entra num grupo de uma das campanhas configuradas.
2. Denuncie esse número pela página publicada.
3. Na execução do workflow `<nome>-execucao`: `Bloqueia` com 200 nas duas grafias, `Remove` com 201 em cada campanha, `Confere` com `success: true`.
4. O número saiu do grupo. Denuncie de novo: a resposta é `repetido`.
5. Tente voltar pelo link de entrada do grupo e anote o que acontece. A documentação do SendFlow não diz se o bloqueio impede.
6. Desbloqueie no painel do SendFlow (anti-spam, números bloqueados). A marca de `repetido` do número expira sozinha depois de `repetido_minutos`.

## 7. Alerta de falha (opcional)

Para ver o e-mail de alerta chegar, mande ao webhook um teste seco com um print quebrado, que faz o workflow de execução falhar de propósito:

```bash
curl -s -X POST https://<n8n>/webhook/<webhook_path> -H "X-Webhook-Token: $T" -H 'Content-Type: application/json' \
  -d '{"client":"<slug>","dry":true,"suspeito":"+5511912345678","denunciante":{"nome":"Teste","whatsapp":"<número da equipe>"},"print":{"mime":"image/jpeg","base64":123}}'
```

Esperado: o webhook responde normalmente e, em seguida, chega `[Golpe] FALHA no workflow <nome>-execucao`.

## Limpeza

Os e-mails `[TESTE]` podem ser apagados. A memória do workflow guarda as denúncias reais por 30 dias; os testes secos não entram nela.
