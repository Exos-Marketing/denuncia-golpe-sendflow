/**
 * Denúncia de número golpista: backend da página /denunciar-golpe/.
 *
 *   POST { suspeito, nome, whatsapp, link?, relato?, print?, empresa? }
 *     1. valida e limita por IP (5 denúncias válidas por hora);
 *     2. número da equipe (lib/numeros-oficiais.ts) responde `oficial` e para aqui;
 *     3. repassa ao n8n, que responde na hora com o status e, em segundo plano, bloqueia no
 *        SendFlow, tira dos grupos e manda o e-mail de conferência.
 *
 * As travas contra denúncia falsa ficam no n8n, porque é ele quem fala com o SendFlow e pode
 * servir a vários sites: lista de protegidos, número repetido em pouco tempo e disjuntor por hora.
 * Esta rota só garante que o n8n receba dado limpo.
 *
 * `empresa` é campo isca, invisível para gente: veio preenchido, responde 200 e descarta.
 * Contrato completo (para portar a outra stack): docs/contrato.md.
 */

import { NextResponse } from "next/server";
import { papelOficial } from "@/lib/numeros-oficiais";
import {
  DENUNCIA_PATH,
  GOLPE_CLIENT,
  LINK_MAX,
  PRINT_MAX_BASE64,
  RELATO_MAX,
  e164Plausivel,
  type DenunciaStatus,
} from "@/lib/denuncia-golpe";

export const dynamic = "force-dynamic";
// Teto de duração em hospedagem serverless (Vercel etc.). O n8n responde em ~1 s; 3 tentativas
// de 8 s com espera de 1 s e 2 s cabem aqui. Fora de serverless isto é ignorado.
export const maxDuration = 30;

// ---- Limite em memória, por IP -------------------------------------------------------
// Reinicia a cada deploy e cada réplica tem o seu. Em serverless (Vercel, Netlify) cada instância
// tem o próprio Map e ele some no cold start: ali o limite é só um freio, e quem segura rajada de
// verdade é o disjuntor do n8n. Quem foi abordado denuncia um ou dois
// números; mais que isso na mesma hora é rajada, e cada denúncia vira bloqueio de verdade.
// Só conta denúncia que passou na validação: errar o DDD não gasta tentativa.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, { count: number; firstAt: number }>();

function overLimit(ip: string): boolean {
  const e = hits.get(ip);
  if (!e) return false;
  if (Date.now() - e.firstAt > WINDOW_MS) {
    hits.delete(ip);
    return false;
  }
  return e.count >= MAX_PER_WINDOW;
}
function registerHit(ip: string) {
  const e = hits.get(ip);
  if (!e || Date.now() - e.firstAt > WINDOW_MS) hits.set(ip, { count: 1, firstAt: Date.now() });
  else e.count += 1;
}
/** Atrás de proxy (Traefik, Vercel, Cloudflare) o IP real vem no x-forwarded-for. */
function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
}

const PRINT_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const digits = (s: string) => s.replace(/\D/g, "");

type N8nResposta = { ok?: boolean; status?: DenunciaStatus };

/** 3 tentativas de 8 s. Devolve o status do n8n, ou null se falhou. */
async function repassar(body: Record<string, unknown>): Promise<DenunciaStatus | null> {
  const url = process.env.GOLPE_WEBHOOK_URL;
  const token = process.env.GOLPE_WEBHOOK_TOKEN;
  if (!url || !token) {
    console.error("[denuncia-golpe] GOLPE_WEBHOOK_URL/GOLPE_WEBHOOK_TOKEN ausente: denúncia NÃO repassada");
    return null;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      const data = (await res.json().catch(() => ({}))) as N8nResposta;
      if (res.ok && data.ok && data.status) return data.status;
      console.error("[denuncia-golpe] n8n recusou", res.status, "tentativa", attempt);
      // 403 = token errado: repetir não muda nada.
      if (res.status === 403) return null;
    } catch (err) {
      console.error("[denuncia-golpe] n8n lançou", String(err), "tentativa", attempt);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return null;
}

export async function POST(request: Request) {
  let data: Record<string, unknown>;
  try {
    data = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Requisição inválida." }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  if (str(data.empresa)) return NextResponse.json({ ok: true, status: "pausado" });

  const ip = clientIp(request);
  if (overLimit(ip)) {
    return NextResponse.json(
      { ok: false, error: "Você já enviou várias denúncias agora. Espere um pouco e tente de novo." },
      { status: 429 },
    );
  }

  const suspeito = str(data.suspeito);
  const nome = str(data.nome).replace(/\s+/g, " ");
  const whatsapp = str(data.whatsapp);
  const link = str(data.link).slice(0, LINK_MAX);
  const relato = str(data.relato).slice(0, RELATO_MAX);
  const print = str(data.print);

  if (!e164Plausivel(suspeito)) {
    return NextResponse.json(
      { ok: false, field: "suspeito", error: "Confira o número que te chamou, com o DDD." },
      { status: 400 },
    );
  }
  if (nome.length < 2 || nome.length > 80) {
    return NextResponse.json({ ok: false, field: "nome", error: "Digite seu nome." }, { status: 400 });
  }
  if (!e164Plausivel(whatsapp)) {
    return NextResponse.json(
      { ok: false, field: "whatsapp", error: "Confira o seu WhatsApp, com o DDD." },
      { status: 400 },
    );
  }
  if (digits(whatsapp) === digits(suspeito)) {
    return NextResponse.json(
      { ok: false, field: "suspeito", error: "Esse é o seu próprio número. Coloque o número de quem te chamou." },
      { status: 400 },
    );
  }

  let printOut: { mime: string; base64: string } | null = null;
  if (print) {
    const m = PRINT_RE.exec(print);
    if (!m || m[2].length > PRINT_MAX_BASE64) {
      return NextResponse.json(
        { ok: false, field: "print", error: "Não consegui usar esse print. Tente outra imagem ou envie sem ele." },
        { status: 400 },
      );
    }
    printOut = { mime: m[1], base64: m[2] };
  }

  registerHit(ip);
  const papel = papelOficial(suspeito);
  if (papel) {
    console.log("[denuncia-golpe] número oficial denunciado, ignorado:", papel);
    return NextResponse.json({ ok: true, status: "oficial" satisfies DenunciaStatus, papel });
  }

  const status = await repassar({
    client: GOLPE_CLIENT,
    dry: process.env.GOLPE_DRY_RUN === "1",
    suspeito,
    denunciante: { nome, whatsapp },
    link: link || null,
    relato: relato || null,
    print: printOut,
    page: DENUNCIA_PATH,
    ip,
    ua: request.headers.get("user-agent"),
    receivedAt: new Date().toISOString(),
  });

  if (!status) {
    // Grep-ável no log do servidor: a denúncia não chegou ao n8n e ninguém foi avisado.
    console.error(
      "[denuncia-golpe] LOST_REPORT",
      JSON.stringify({ suspeito, nome, whatsapp, link, relato, print: !!printOut }),
    );
    return NextResponse.json(
      { ok: false, error: "Não conseguimos registrar agora. Tente de novo em instantes ou fale com o suporte." },
      { status: 502 },
    );
  }

  console.log("[denuncia-golpe] ok", suspeito, "->", status);
  return NextResponse.json({ ok: true, status });
}
