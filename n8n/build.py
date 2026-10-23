#!/usr/bin/env python3
"""Gera e publica o workflow n8n de denúncia de golpe.

    python3 n8n/build.py                          # gera n8n/workflow.json e workflow-execucao.json
    python3 n8n/build.py --listar-campanhas ID    # campanhas do SendFlow (projeto ID) prontas p/ o config
    python3 n8n/build.py --criar-credenciais      # cria no n8n as credenciais que faltam e grava os ids no config
    python3 n8n/build.py --push                   # gera + cria/atualiza os workflows no n8n e ativa

Gera três workflows: o principal (webhook, decisão, resposta), "<nome>-execucao" (SendFlow e
e-mail, chamado sem esperar) e "<nome>-alerta" (e-mail para a equipe se algum dos dois falhar).
Testado no n8n 2.10.

Variáveis de ambiente (nunca no git):
    N8N_API_BASE       ex.: https://n8n.suaempresa.com/api/v1
    N8N_API_KEY        n8n > Settings > n8n API
    SENDFLOW_API_KEY   chave da SendAPI só para este fluxo (para --criar-credenciais e --listar-campanhas)
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE   opcionais: criam a credencial SMTP

O JS dos nós Code mora em decide.js, remocao.js e email.js. Edite lá e rode o build; edição
feita no editor do n8n é sobrescrita pelo próximo --push. Só depende da biblioteca padrão.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEADER_TOKEN = "X-Webhook-Token"
# O WAF do SendFlow recusa User-Agent de biblioteca (o 403 parece chave bloqueada).
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
NS = uuid.UUID("6f1d3a52-4c1e-4e0b-9a51-0d6c0e9b5a11")


def sid(name: str) -> str:
    """ID estável por nome: rebuild não muda id de nó nem o webhookId."""
    return str(uuid.uuid5(NS, name))


def die(msg: str) -> None:
    sys.exit(f"❌ {msg}")


# ------------------------------------------------------------------ config

def load_config(path: Path) -> dict:
    if not path.exists():
        die(f"{path} não existe. Copie n8n/config.example.json para n8n/config.json e preencha.")
    cfg = json.loads(path.read_text())
    for k in ("workflow_name", "webhook_path", "email_para", "email_de", "clientes", "credenciais"):
        if k not in cfg:
            die(f"config sem a chave '{k}' (veja config.example.json)")
    if not isinstance(cfg.get("bloqueio_automatico", False), bool):
        die('bloqueio_automatico tem que ser true ou false (sem aspas)')
    for slug, c in cfg["clientes"].items():
        if not c.get("releases"):
            print(f"⚠️  cliente '{slug}' sem campanhas: o número é bloqueado mas não sai de grupo nenhum")
    return cfg


EXEMPLOS = {"551100000001", "5511900000002"}


def placeholders(cfg: dict, prot: list[str]) -> list[str]:
    """O que ainda é valor de exemplo. Exemplo esquecido em `protegidos` esconde o aviso de lista
    vazia, e campanha de exemplo faz a remoção falhar em silêncio."""
    out = []
    if EXEMPLOS & set(prot):
        out.append("protegidos ainda tem os números de exemplo (+55 11 0000-0001 / 90000-0002)")
    for slug, c in cfg["clientes"].items():
        if any(r.get("id") == "ID_DA_CAMPANHA_NO_SENDFLOW" for r in c.get("releases", [])):
            out.append(f"clientes.{slug}.releases ainda tem a campanha de exemplo")
    if cfg.get("email_para", "").endswith("@suaempresa.com.br"):
        out.append("email_para ainda é o de exemplo")
    return out


def save_config(path: Path, cfg: dict) -> None:
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")


# ------------------------------------------------------------------ protegidos

PHONE_RE = re.compile(r"\+?\d[\d ().-]{7,20}\d")


def numeros_em(texto: str) -> set[str]:
    """Telefones de um texto, em dígitos com DDI. Prefere incluir demais: número protegido a
    mais só deixa de ser bloqueado sozinho (o e-mail chega igual); a menos, bloqueia gente da
    equipe na conta inteira do SendFlow."""
    out: set[str] = set()
    for m in PHONE_RE.finditer(texto):
        raw = m.group().strip()
        d = re.sub(r"\D", "", raw)
        if raw.startswith("+"):
            if 10 <= len(d) <= 15:
                out.add(d)
        elif d.startswith("55") and len(d) in (12, 13):
            out.add(d)
        elif len(d) in (10, 11) and d[0] != "0":
            out.add("55" + d)  # sem DDI: lido como brasileiro
    return out


def protegidos(cfg: dict, base: Path) -> tuple[list[str], dict[str, list[str]]]:
    todos: set[str] = set()
    origem: dict[str, list[str]] = {}
    for n in cfg.get("protegidos", []):
        for d in numeros_em(str(n)) or {re.sub(r"\D", "", str(n))}:
            if d:
                todos.add(d)
                origem.setdefault(d, []).append("config.json")
    for pattern in cfg.get("protegidos_arquivos", []):
        files = sorted(glob.glob(str((base / pattern).resolve()) if not os.path.isabs(pattern) else pattern, recursive=True))
        if not files:
            print(f"⚠️  protegidos_arquivos: nada casou com {pattern}")
        for f in files:
            for d in numeros_em(Path(f).read_text(errors="ignore")):
                todos.add(d)
                origem.setdefault(d, []).append(os.path.relpath(f, base))
    if not todos:
        print("⚠️  lista de protegidos VAZIA: nenhum número da equipe está a salvo de denúncia falsa")
    return sorted(todos), origem


# ------------------------------------------------------------------ workflow

def js(nome: str) -> str:
    return (HERE / nome).read_text()


def worker_name(cfg: dict) -> str:
    return f"{cfg['workflow_name']}-execucao"


WORKER_ID_PLACEHOLDER = "__ID_DO_WORKFLOW_DE_EXECUCAO__"


def alert_name(cfg: dict) -> str:
    return f"{cfg['workflow_name']}-alerta"


ALERTA_ID_PLACEHOLDER = "__ID_DO_WORKFLOW_DE_ALERTA__"


def build_alerta(cfg: dict) -> dict:
    """Error workflow: se o principal ou o de execução falhar, a equipe recebe e-mail. Sem ele a
    falha seria silenciosa: a pessoa já leu "está sendo bloqueado" quando o de execução roda."""
    texto = (
        "=O workflow {{ $json.workflow.name }} falhou"
        "{{ $json.execution.lastNodeExecuted ? ' no nó ' + $json.execution.lastNodeExecuted : '' }}.\n\n"
        "Erro: {{ $json.execution.error ? $json.execution.error.message : 'sem mensagem' }}\n"
        "Execução: {{ $json.execution.url }}\n\n"
        "Se foi no workflow de execução, quem denunciou viu a confirmação na página, mas o número pode "
        "não ter sido bloqueado e o e-mail de conferência não saiu. Abra a execução, pegue o número no "
        "nó Recebe e bloqueie à mão no painel do SendFlow.\n"
    )
    return {
        "name": alert_name(cfg),
        "nodes": [
            {"id": sid("Erro"), "name": "Erro", "type": "n8n-nodes-base.errorTrigger", "typeVersion": 1,
             "position": [0, 300], "parameters": {}},
            {"id": sid("Avisa"), "name": "Avisa", "type": "n8n-nodes-base.emailSend", "typeVersion": 2.1,
             "position": [220, 300],
             "parameters": {"fromEmail": cfg["email_de"], "toEmail": cfg["email_para"],
                            "subject": "=[Golpe] FALHA no workflow {{ $json.workflow.name }}",
                            "emailFormat": "text", "text": texto, "options": {"appendAttribution": False}},
             "credentials": {"smtp": cfg["credenciais"]["smtp"]}},
        ],
        "connections": {"Erro": {"main": [[{"node": "Avisa", "type": "main", "index": 0}]]}},
        "settings": {"executionOrder": "v1", "timezone": cfg.get("timezone", "America/Sao_Paulo")},
    }


def build(cfg: dict, prot: list[str], worker_id: str = WORKER_ID_PLACEHOLDER,
          alerta_id: str = ALERTA_ID_PLACEHOLDER) -> tuple[dict, dict]:
    """Dois workflows. O principal (Webhook → Decide → Responde → Executa) termina em menos de
    1s, para a memória do Decide ser gravada logo e denúncias simultâneas se enxergarem. O de
    execução (bloqueio, remoção, conferência, e-mail) é chamado sem esperar."""
    base_sf = cfg.get("sendflow_base", "https://sendflow.pro/sendapi").rstrip("/")
    cred = cfg["credenciais"]
    espera = int(cfg.get("espera_conferencia_s", 60))

    injetado = {k: cfg[k] for k in ("email_para", "clientes") if k in cfg}
    injetado.update({
        "protegidos": prot,
        "bloqueio_automatico": cfg.get("bloqueio_automatico", False) is True,
        "limite_por_hora": cfg.get("limite_por_hora", 10),
        "repetido_minutos": cfg.get("repetido_minutos", 60),
    })
    decide_src = js("decide.js")
    decide = decide_src.replace("/*__CONFIG__*/ {}", json.dumps(injetado, ensure_ascii=False))
    if decide == decide_src:
        die("marcador /*__CONFIG__*/ {} não encontrado em decide.js")

    def http(name: str, method: str, url: str, pos: list[int], body: str | None = None) -> dict:
        params: dict = {
            "method": method, "url": url,
            "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
            "sendHeaders": True, "headerParameters": {"parameters": [{"name": "User-Agent", "value": UA}]},
            "options": {
                # Um por vez: bloqueio exige 1s entre chamadas, GET /actions/{id} é 1/s por usuário.
                "batching": {"batch": {"batchSize": 1, "batchInterval": 1200}},
                # Status e corpo viram dado: o e-mail mostra cada resposta, e 4xx não derruba o fluxo.
                "response": {"response": {"fullResponse": True, "neverError": True}},
                "timeout": 20000,
            },
        }
        if body is not None:
            params.update({"sendBody": True, "specifyBody": "json", "jsonBody": body})
        return {"id": sid(name), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
                "position": pos, "parameters": params, "onError": "continueRegularOutput",
                "credentials": {"httpHeaderAuth": cred["sendflow"]}}

    def code(name: str, source: str, pos: list[int]) -> dict:
        return {"id": sid(name), "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2,
                "position": pos, "parameters": {"jsCode": source}}

    def se(name: str, expr: str, pos: list[int]) -> dict:
        return {"id": sid(name), "name": name, "type": "n8n-nodes-base.if", "typeVersion": 1, "position": pos,
                "parameters": {"conditions": {"boolean": [{"value1": expr, "value2": True}]}}}

    def to(*names: str) -> list[list[dict]]:
        return [[{"node": n, "type": "main", "index": 0} for n in names]]

    def bifurca(sim: str, nao: str) -> list[list[dict]]:
        return [[{"node": sim, "type": "main", "index": 0}], [{"node": nao, "type": "main", "index": 0}]]

    settings = {"executionOrder": "v1", "timezone": cfg.get("timezone", "America/Sao_Paulo"),
                "errorWorkflow": cfg.get("error_workflow") or alerta_id}

    # ---------- principal ----------
    principal = {
        "name": cfg["workflow_name"],
        "nodes": [
            {"id": sid("Webhook"), "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2,
             "position": [0, 300], "webhookId": sid("webhook-path:" + cfg["webhook_path"]),
             "parameters": {"httpMethod": "POST", "path": cfg["webhook_path"], "authentication": "headerAuth",
                            "responseMode": "responseNode", "options": {}},
             "credentials": {"httpHeaderAuth": cred["webhook"]}},
            code("Decide", decide, [220, 300]),
            {"id": sid("Responde"), "name": "Responde", "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1,
             "position": [440, 300],
             "parameters": {"respondWith": "json",
                            "responseBody": "={{ JSON.stringify({ ok: true, status: $json.status }) }}", "options": {}}},
            {"id": sid("Executa"), "name": "Executa", "type": "n8n-nodes-base.executeWorkflow", "typeVersion": 1.2,
             "position": [660, 300],
             "parameters": {"workflowId": {"__rl": True, "value": worker_id, "mode": "id"},
                            "options": {"waitForSubWorkflow": False}}},
        ],
        "connections": {
            "Webhook": {"main": to("Decide")},
            "Decide": {"main": to("Responde")},
            "Responde": {"main": to("Executa")},
        },
        "settings": settings,
    }

    # ---------- execução ----------
    itens_bloqueio = (
        "// Uma chamada por grafia do número (com e sem o 9).\n"
        "const d = $input.first().json;\n"
        "const quando = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });\n"
        "return d.variantes.map((v) => ({ json: { number: v, name: `Golpe denunciado ${d.sigla} ${quando}` } }));\n"
    )
    execucao = {
        "name": worker_name(cfg),
        "nodes": [
            {"id": sid("Recebe"), "name": "Recebe", "type": "n8n-nodes-base.executeWorkflowTrigger",
             "typeVersion": 1.1, "position": [0, 300], "parameters": {"inputSource": "passthrough"}},
            se("Bloquear agora?", "={{ $json.status === 'bloqueado' && !$json.dry }}", [220, 300]),
            code("Itens de bloqueio", itens_bloqueio, [440, 160]),
            http("Bloqueia", "POST", f"{base_sf}/block-numbers", [660, 160],
                 body="={{ JSON.stringify({ number: $json.number, name: $json.name }) }}"),
            code("Itens de remoção", js("remocao.js"), [880, 160]),
            se("Pular remoção?", "={{ $json.pular === true }}", [1100, 160]),
            http("Remove", "POST", f"{base_sf}/actions/remove-participants", [1320, 40],
                 body=("={{ JSON.stringify({ releaseId: $json.releaseId, accountsFrom: 'release', "
                       "to: { type: 'release', ids: [$json.releaseId] }, data: { participants: $json.participants } }) }}")),
            # Abaixo de 65s a espera fica em memória; acima, o n8n grava a execução em espera no banco.
            {"id": sid("Espera"), "name": "Espera", "type": "n8n-nodes-base.wait", "typeVersion": 1.1,
             "position": [1540, 40], "webhookId": sid("espera"), "parameters": {"amount": espera, "unit": "seconds"}},
            http("Confere", "GET",
                 f"={base_sf}/actions/{{{{ ($json.body && ($json.body.actionId || $json.body.id)) || 'sem-id' }}}}",
                 [1760, 40]),
            code("Monta e-mail", js("email.js"), [1980, 300]),
            {"id": sid("Envia e-mail"), "name": "Envia e-mail", "type": "n8n-nodes-base.emailSend", "typeVersion": 2.1,
             "position": [2200, 300],
             "parameters": {"fromEmail": cfg["email_de"], "toEmail": "={{ $json.to }}", "subject": "={{ $json.subject }}",
                            "html": "={{ $json.html }}", "options": {"attachments": "print", "appendAttribution": False}},
             "credentials": {"smtp": cred["smtp"]}},
        ],
        "connections": {
            "Recebe": {"main": to("Bloquear agora?")},
            "Bloquear agora?": {"main": bifurca("Itens de bloqueio", "Monta e-mail")},
            "Itens de bloqueio": {"main": to("Bloqueia")},
            "Bloqueia": {"main": to("Itens de remoção")},
            "Itens de remoção": {"main": to("Pular remoção?")},
            "Pular remoção?": {"main": bifurca("Monta e-mail", "Remove")},
            "Remove": {"main": to("Espera")},
            "Espera": {"main": to("Confere")},
            "Confere": {"main": to("Monta e-mail")},
            "Monta e-mail": {"main": to("Envia e-mail")},
        },
        "settings": settings,
    }
    return principal, execucao


# ------------------------------------------------------------------ APIs

def n8n(method: str, path: str, payload: dict | None = None, fatal: bool = True) -> dict:
    base, key = os.environ.get("N8N_API_BASE"), os.environ.get("N8N_API_KEY")
    if not base or not key:
        die("defina N8N_API_BASE (ex.: https://n8n.suaempresa.com/api/v1) e N8N_API_KEY")
    req = urllib.request.Request(
        base.rstrip("/") + path, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-N8N-API-KEY": key, "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        msg = f"n8n {method} {path}: {e.code} {e.read()[:400]!r}"
        if fatal:
            die(msg)
        return {"_erro": msg}
    return {}


def sendflow_get(cfg: dict, path: str):
    key = os.environ.get("SENDFLOW_API_KEY")
    if not key:
        die("defina SENDFLOW_API_KEY")
    base = cfg.get("sendflow_base", "https://sendflow.pro/sendapi").rstrip("/")
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {key}", "User-Agent": UA,
                                                       "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        die(f"SendFlow GET {path}: {e.code} {e.read()[:300]!r}  (403 = limite; espere 5 min antes de repetir)")


def listar_campanhas(cfg: dict, projeto: str | None) -> None:
    # GET /releases aceita UMA chamada a cada 5 minutos. Em limite, pode devolver campos null
    # em vez de erro: confira o resultado antes de colar no config.
    rel = sendflow_get(cfg, "/releases")
    rows = [r for r in rel if (not projeto or r.get("projectId") == projeto)]
    nulos = sum(1 for r in rows if r.get("name") is None)
    if nulos:
        print(f"⚠️  {nulos} campanhas com nome null: provável rate limit. Espere 5 min e repita.")
    ativas = [r for r in rows if not r.get("archived") and r.get("type") == "WhatsRelease"]
    fora = [r for r in rows if r not in ativas]
    print(json.dumps([{"id": r["id"], "nome": r.get("name")} for r in ativas], ensure_ascii=False, indent=2))
    print(f"\n{len(ativas)} campanhas de grupo ativas (cole em clientes.<slug>.releases).")
    for r in fora:
        print(f"   fora: {r.get('name')} ({'arquivada' if r.get('archived') else r.get('type')})")


def criar_credenciais(cfg: dict, cfg_path: Path) -> None:
    cred = cfg["credenciais"]
    existentes = {c["name"]: c["id"] for c in n8n("GET", "/credentials?limit=250").get("data", [])}

    def garante(chave: str, tipo: str, dados_fn) -> None:
        item = cred[chave]
        if item.get("id"):
            print(f"✔ {chave}: já configurada ({item['name']})")
            return
        if item["name"] in existentes:
            item["id"] = existentes[item["name"]]
            print(f"✔ {chave}: achei '{item['name']}' no n8n")
            return
        dados = dados_fn()
        if dados is None:
            return
        item["id"] = n8n("POST", "/credentials", {"name": item["name"], "type": tipo, "data": dados})["id"]
        print(f"✔ {chave}: criada '{item['name']}'")

    def webhook():
        token = secrets.token_urlsafe(32)
        pasta = HERE / ".segredos"
        pasta.mkdir(exist_ok=True)
        arq = pasta / "webhook-token"
        arq.write_text(token + "\n")
        os.chmod(arq, 0o600)
        print(f"   segredo do webhook salvo em {arq.relative_to(HERE.parent)} (chmod 600).")
        print("   Ponha o MESMO valor na env GOLPE_WEBHOOK_TOKEN do site.")
        return {"name": HEADER_TOKEN, "value": token}

    def sendflow():
        key = os.environ.get("SENDFLOW_API_KEY")
        if not key:
            print("⚠️  sendflow: defina SENDFLOW_API_KEY para criar a credencial")
            return None
        return {"name": "Authorization", "value": f"Bearer {key}"}

    def smtp():
        host = os.environ.get("SMTP_HOST")
        if not host:
            print("⚠️  smtp: crie a credencial SMTP no painel do n8n e cole o id em credenciais.smtp.id,"
                  " ou defina SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD")
            return None
        return {"host": host, "port": int(os.environ.get("SMTP_PORT", "465")),
                "user": os.environ.get("SMTP_USER", ""), "password": os.environ.get("SMTP_PASSWORD", ""),
                "secure": os.environ.get("SMTP_SECURE", "true").lower() == "true"}

    garante("webhook", "httpHeaderAuth", webhook)
    garante("sendflow", "httpHeaderAuth", sendflow)
    garante("smtp", "smtp", smtp)
    save_config(cfg_path, cfg)
    print(f"✔ ids gravados em {cfg_path.name}")


def upsert(wf: dict, ativar: bool) -> str:
    nome = wf["name"]
    found = [w for w in n8n("GET", f"/workflows?name={nome}&limit=50").get("data", []) if w["name"] == nome]
    if found:
        wid = found[0]["id"]
        # Backup do que está no ar antes de sobrescrever (n8n/.backup/, fora do git).
        atual = n8n("GET", f"/workflows/{wid}")
        pasta = HERE / ".backup"
        pasta.mkdir(exist_ok=True)
        (pasta / f"{nome}-{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(json.dumps(atual, ensure_ascii=False, indent=2))
        estava_ativo = found[0].get("active")
        if estava_ativo:
            n8n("POST", f"/workflows/{wid}/deactivate")
        r = n8n("PUT", f"/workflows/{wid}", wf, fatal=False)
        if "_erro" in r:
            if estava_ativo:
                n8n("POST", f"/workflows/{wid}/activate", fatal=False)  # volta ao que estava no ar
            die(f"{r['_erro']} (versão anterior reativada; backup em n8n/.backup/)")
    else:
        wid = n8n("POST", "/workflows", wf)["id"]
    if ativar:
        # Reativar é o que registra o webhook (sem isso a URL de produção devolve 404).
        r = n8n("POST", f"/workflows/{wid}/activate", fatal=ativar is True)
        if "_erro" in r:
            print(f"   (não ativou {nome}: {r['_erro'][:120]})")
    return wid


def push(cfg: dict, prot: list[str]) -> tuple[str, str, str]:
    faltando = [k for k, v in cfg["credenciais"].items() if not v.get("id")]
    if faltando:
        die(f"credenciais sem id: {', '.join(faltando)} (rode --criar-credenciais)")
    problemas = placeholders(cfg, prot)
    if problemas:
        die("o config ainda tem valores de exemplo:\n   - " + "\n   - ".join(problemas))
    # Ordem: alerta (error workflow), execução (o principal precisa do id dele, e o n8n recusa
    # ativar quem chama sub-workflow não publicado), principal.
    alerta_id = cfg.get("error_workflow") or upsert(build_alerta(cfg), ativar="tentar")
    _, execucao = build(cfg, prot, alerta_id=alerta_id)
    wid_exec = upsert(execucao, ativar=True)
    principal, _ = build(cfg, prot, worker_id=wid_exec, alerta_id=alerta_id)
    wid = upsert(principal, ativar=True)
    return wid, wid_exec, alerta_id


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--out", default=str(HERE / "workflow.json"))
    ap.add_argument("--push", action="store_true", help="cria/atualiza o workflow no n8n e ativa")
    ap.add_argument("--criar-credenciais", action="store_true", help="cria no n8n as credenciais sem id")
    ap.add_argument("--listar-campanhas", metavar="PROJECT_ID", nargs="?", const="",
                    help="lista as campanhas do SendFlow (opcional: só de um projeto)")
    args = ap.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = load_config(cfg_path)

    if args.listar_campanhas is not None:
        listar_campanhas(cfg, args.listar_campanhas or None)
        return
    if args.criar_credenciais:
        criar_credenciais(cfg, cfg_path)
        return

    prot, origem = protegidos(cfg, cfg_path.parent)
    principal, execucao = build(cfg, prot)
    out = Path(args.out)
    out_exec = out.with_name(out.stem.replace(".example", "") + "-execucao" + (".example" if ".example" in out.stem else "") + out.suffix)
    out.write_text(json.dumps(principal, ensure_ascii=False, indent=2) + "\n")
    out_exec.write_text(json.dumps(execucao, ensure_ascii=False, indent=2) + "\n")
    out_alerta = Path(str(out_exec).replace("-execucao", "-alerta"))
    out_alerta.write_text(json.dumps(build_alerta(cfg), ensure_ascii=False, indent=2) + "\n")
    print(f"✔ {out.name} + {out_exec.name} + {out_alerta.name} gerados · {len(prot)} números protegidos · "
          f"{sum(len(c.get('releases', [])) for c in cfg['clientes'].values())} campanhas · "
          f"bloqueio {'AUTOMÁTICO' if cfg.get('bloqueio_automatico', False) is True else 'em modo aprovação'}")
    for problema in placeholders(cfg, prot):
        print(f"⚠️  {problema} (o --push recusa enquanto isso não for trocado)")
    for n in prot:
        print(f"   +{n}  ← {', '.join(sorted(set(origem[n])))[:100]}")
    if args.push:
        wid, wid_exec, alerta_id = push(cfg, prot)
        print(f"✔ publicado: {cfg['workflow_name']} ({wid}, ativo) chama {worker_name(cfg)} ({wid_exec});"
              f" falhas avisam por {alert_name(cfg) if not cfg.get('error_workflow') else 'error_workflow'} ({alerta_id})")
        print(f"   webhook: /webhook/{cfg['webhook_path']}")


if __name__ == "__main__":
    main()
