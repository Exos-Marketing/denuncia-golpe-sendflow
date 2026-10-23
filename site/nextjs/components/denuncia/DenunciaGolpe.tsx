"use client";

// ============================================================
// Denúncia de número golpista (/denunciar-golpe/).
//
// Quem foi abordado no privado manda o número (e, se quiser, um print). A rota
// /api/denuncia-golpe/ repassa ao n8n, que bloqueia o número no SendFlow, tira dos grupos
// e manda um e-mail de conferência para a equipe.
//
// Textos, links e cores vêm de lib/denuncia-golpe.ts. Precisa de Tailwind (v3.2+ ou v4) e
// de `react-phone-number-input`. O estilo do campo de telefone está no <style> abaixo, para
// não depender do CSS do seu site.
//
// De propósito NÃO é <form>: scripts de rastreamento de CRM que escutam `submit` (o
// external-tracking do GoHighLevel, por exemplo) criam contato vazio a cada envio. E sem
// pixel `Lead`: isto não é captação.
// ============================================================

import { useId, useRef, useState, useSyncExternalStore } from "react";
import PhoneInput, { isValidPhoneNumber } from "react-phone-number-input";
import flags from "react-phone-number-input/flags";
import "react-phone-number-input/style.css";
import {
  CORES,
  DENUNCIA_API,
  LINK_MAX,
  MARCA,
  RELATO_MAX,
  rastrearSuporte,
  type DenunciaStatus,
} from "@/lib/denuncia-golpe";

const PRINT_MAX_PX = 1600;

type Field = "suspeito" | "nome" | "whatsapp" | "print";
type Errors = Partial<Record<Field, string>>;
type Done = { status: DenunciaStatus; papel?: string };

/** Número em dígitos (do ?n=) → E.164 aceito pelo PhoneInput. */
function toE164(raw: string): string | undefined {
  const d = raw.replace(/\D/g, "");
  if (!d) return undefined;
  if (raw.trim().startsWith("+")) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if (d.length >= 12) return `+${d}`;
  return undefined;
}

/** `?n=` preenche o número denunciado (link vindo de uma página de verificação, por exemplo). */
let cachedSuspeito: string | undefined | null = null;
function readSuspeito(): string | undefined {
  if (cachedSuspeito !== null) return cachedSuspeito;
  if (typeof window === "undefined") return undefined;
  cachedSuspeito = toE164(new URLSearchParams(window.location.search).get("n") || "");
  return cachedSuspeito;
}
const noSubscribe = () => () => {};

/** Reduz o print no navegador (JPEG, lado maior até 1600px): foto de celular tem 4 a 8 MB. */
function comprimir(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, PRINT_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * escala);
      canvas.height = Math.round(img.naturalHeight * escala);
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error("canvas"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

const ESTILO = `html,body{background:${CORES.fundo}}
.dg{--dg-bg:${CORES.fundo};--dg-primary:${CORES.destaque};--dg-primary-hover:${CORES.destaqueHover};--dg-eyebrow:${CORES.sobretitulo}}
.dg-phone{width:100%;margin-top:.375rem;min-height:3.1rem;border-radius:.75rem;border:1px solid rgb(0 0 0/.15);background:#fff;padding:.35rem .85rem;transition:box-shadow .2s,border-color .2s;--PhoneInputCountrySelectArrow-color:#7a6a75;--PhoneInput-color--focus:var(--dg-primary)}
.dg-phone:focus-within{border-color:var(--dg-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dg-primary) 22%,transparent)}
.dg-phone .PhoneInputInput{border:none;outline:none;background:transparent;padding:.4rem 0;font-size:1rem;color:#1b0b17}
.dg-phone .PhoneInputCountryIcon,.dg-phone .PhoneInputCountrySelect:focus+.PhoneInputCountryIcon{box-shadow:none}
.dg-phone:has(input[aria-invalid="true"]){border-color:#f87171}
.dg-input:focus{border-color:var(--dg-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dg-primary) 25%,transparent)}
.dg-anexar{background:color-mix(in srgb,var(--dg-primary) 10%,transparent);color:var(--dg-primary)}
.dg-anexar:hover{background:color-mix(in srgb,var(--dg-primary) 16%,transparent)}`;

const INPUT =
  "dg-input mt-1.5 w-full rounded-xl border border-black/15 px-4 py-3 text-base outline-none aria-[invalid=true]:border-red-400";
const LABEL = "text-sm font-bold";
const CARD = "mt-7 rounded-2xl bg-white p-5 text-[#1b0b17] shadow-xl";

export default function DenunciaGolpe() {
  const uid = useId();
  const inicial = useSyncExternalStore(noSubscribe, readSuspeito, () => undefined);
  const [suspeitoEdit, setSuspeito] = useState<string | undefined | null>(null);
  const suspeito = suspeitoEdit === null ? inicial : suspeitoEdit;
  const [nome, setNome] = useState("");
  const [whatsapp, setWhatsapp] = useState<string | undefined>(undefined);
  const [link, setLink] = useState("");
  const [relato, setRelato] = useState("");
  const [empresa, setEmpresa] = useState("");
  const [print, setPrint] = useState<{ dataUrl: string; nome: string } | null>(null);
  const [lendoPrint, setLendoPrint] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState<Done | null>(null);

  const focusField = (f: Field) => rootRef.current?.querySelector<HTMLElement>(`[data-field="${f}"]`)?.focus();

  const onPrint = async (file: File | undefined) => {
    setErrors((e) => ({ ...e, print: undefined }));
    if (!file) return setPrint(null);
    if (!file.type.startsWith("image/")) {
      setPrint(null);
      return setErrors((e) => ({ ...e, print: "Escolha uma imagem (o print da conversa)." }));
    }
    setLendoPrint(true);
    try {
      setPrint({ dataUrl: await comprimir(file), nome: file.name });
    } catch {
      setPrint(null);
      setErrors((e) => ({ ...e, print: "Não consegui ler essa imagem. Tente outro print ou envie sem ele." }));
    } finally {
      setLendoPrint(false);
    }
  };

  const validate = (): Errors => {
    const e: Errors = {};
    if (!suspeito || !isValidPhoneNumber(suspeito)) e.suspeito = "Confira o número que te chamou, com o DDD.";
    if (nome.trim().length < 2) e.nome = "Digite seu nome.";
    if (!whatsapp || !isValidPhoneNumber(whatsapp)) e.whatsapp = "Confira o seu WhatsApp, com o DDD.";
    else if (suspeito && whatsapp === suspeito) e.suspeito = "Esse é o seu número. Coloque o número de quem te chamou.";
    return e;
  };

  const handleSubmit = async () => {
    if (submittingRef.current || lendoPrint) return;
    const found = validate();
    setErrors(found);
    setFormError(null);
    const first = (["suspeito", "nome", "whatsapp"] as Field[]).find((f) => found[f]);
    if (first) return focusField(first);

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch(DENUNCIA_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suspeito,
          nome: nome.trim(),
          whatsapp,
          link: link.trim(),
          relato: relato.trim(),
          print: print?.dataUrl ?? "",
          empresa,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: DenunciaStatus;
        papel?: string;
        error?: string;
        field?: Field;
      };
      if (!res.ok || !data.ok || !data.status) {
        const msg = data.error ?? "Não conseguimos registrar agora. Tente de novo em instantes.";
        if (data.field) {
          setErrors({ [data.field]: msg });
          focusField(data.field);
        } else {
          setFormError(msg);
        }
        return;
      }
      setDone({ status: data.status, papel: data.papel });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setFormError("Sem conexão. Verifique a internet e tente de novo.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const recomecar = () => {
    setDone(null);
    setSuspeito(undefined);
    setLink("");
    setRelato("");
    setPrint(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const err = (f: Field) =>
    errors[f] ? (
      <p id={`${uid}-${f}-err`} className="mt-1.5 mb-0 text-[0.8rem] font-medium text-red-700">
        {errors[f]}
      </p>
    ) : null;

  const suporte = (
    <a className="font-bold underline" href={MARCA.suporteHref} onClick={rastrearSuporte}>
      suporte oficial
    </a>
  );

  return (
    <main className="dg min-h-screen bg-[var(--dg-bg)] px-4 py-12 text-white sm:py-20">
      <style>{ESTILO}</style>
      <div className="mx-auto w-full max-w-md">
        <p className="m-0 text-sm font-bold tracking-wide text-[var(--dg-eyebrow)]">{MARCA.nome}</p>
        <h1 className="mt-2 text-[1.9rem] font-extrabold leading-tight tracking-tight">Denuncie um número golpista</h1>
        <p className="mt-3 text-[1rem] leading-relaxed text-white/80">
          Recebeu mensagem de alguém se passando por {MARCA.nome} ou pela equipe, oferecendo desconto, vaga ou pedindo
          pagamento? Mande o número aqui. Ele é bloqueado e retirado dos nossos grupos, e a equipe confere cada denúncia.
        </p>

        {done ? (
          <div key="feito" className={CARD} role="status">
            {done.status === "oficial" ? (
              <div className="rounded-xl border border-green-300 bg-green-50 p-4 text-green-900">
                <p className="m-0 font-bold">✅ Esse número é da nossa equipe</p>
                <p className="mt-1 mb-0 text-sm">
                  {done.papel ? `${done.papel}. ` : ""}Ele é oficial e não foi bloqueado. Se a mensagem pareceu estranha
                  mesmo assim, fale com o {suporte}.
                </p>
              </div>
            ) : done.status === "pausado" ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
                <p className="m-0 font-bold">Recebemos sua denúncia</p>
                <p className="mt-1 mb-0 text-sm">A equipe vai conferir e bloquear o número. Obrigado por avisar.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-green-300 bg-green-50 p-4 text-green-900">
                <p className="m-0 font-bold">✅ Denúncia recebida</p>
                <p className="mt-1 mb-0 text-sm">
                  {done.status === "repetido"
                    ? "Esse número já tinha sido denunciado e já está sendo bloqueado e retirado dos grupos."
                    : "Esse número está sendo bloqueado e retirado dos nossos grupos."}{" "}
                  Obrigado por proteger a comunidade.
                </p>
              </div>
            )}
            <p className="mt-4 mb-0 text-sm leading-relaxed text-black/75">
              Não responda a esse número, não clique nos links que ele mandou e não faça nenhum pagamento. Se você já
              pagou ou passou algum dado, fale agora com o {suporte}.
            </p>
            <button
              type="button"
              onClick={recomecar}
              className="mt-4 w-full rounded-xl border border-black/15 py-3 text-sm font-bold text-[#1b0b17] transition-colors hover:bg-black/5"
            >
              Denunciar outro número
            </button>
          </div>
        ) : (
          <div key="form" ref={rootRef} className={CARD} role="group" aria-label="Denúncia de número golpista">
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label htmlFor={`${uid}-suspeito`} className={LABEL}>
                  Número que te chamou
                </label>
                <PhoneInput
                  id={`${uid}-suspeito`}
                  data-field="suspeito"
                  international
                  defaultCountry="BR"
                  countryCallingCodeEditable={false}
                  limitMaxLength
                  flags={flags}
                  value={suspeito}
                  onChange={setSuspeito}
                  placeholder="(11) 90000-0000"
                  className="dg-phone"
                  aria-invalid={!!errors.suspeito}
                  aria-describedby={errors.suspeito ? `${uid}-suspeito-err` : undefined}
                />
                {err("suspeito") ?? (
                  <p className="mt-1.5 mb-0 text-[0.8rem] text-black/60">
                    Copie do WhatsApp do jeito que aparece. Se for de outro país, troque a bandeira.
                  </p>
                )}
              </div>

              <div>
                <p className={`${LABEL} m-0`}>
                  Print da conversa <span className="font-normal text-black/55">(opcional)</span>
                </p>
                {/* Input nativo escondido: o botão dele vem no idioma do navegador ("Choose File"). */}
                <input
                  ref={fileRef}
                  id={`${uid}-print`}
                  data-field="print"
                  type="file"
                  accept="image/*"
                  onChange={(e) => void onPrint(e.target.files?.[0])}
                  className="sr-only"
                  aria-describedby={errors.print ? `${uid}-print-err` : undefined}
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label
                    htmlFor={`${uid}-print`}
                    className="dg-anexar cursor-pointer rounded-lg px-3.5 py-2 text-sm font-bold transition-colors"
                  >
                    {print ? "Trocar print" : "Anexar print"}
                  </label>
                  {lendoPrint && <span className="text-[0.8rem] text-black/60">Preparando a imagem...</span>}
                  {print && !lendoPrint && (
                    <span className="min-w-0 truncate text-[0.8rem] text-green-800">✓ {print.nome}</span>
                  )}
                </div>
                {err("print")}
              </div>

              <div>
                <label htmlFor={`${uid}-link`} className={LABEL}>
                  Link que a pessoa mandou <span className="font-normal text-black/55">(opcional)</span>
                </label>
                <input
                  id={`${uid}-link`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  maxLength={LINK_MAX}
                  placeholder="Cole aqui, sem abrir o link"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  className={INPUT}
                />
              </div>

              <div>
                <label htmlFor={`${uid}-relato`} className={LABEL}>
                  O que a pessoa disse? <span className="font-normal text-black/55">(opcional)</span>
                </label>
                <textarea
                  id={`${uid}-relato`}
                  rows={3}
                  maxLength={RELATO_MAX}
                  placeholder="Ex.: ofereceu desconto na matrícula e pediu Pix"
                  value={relato}
                  onChange={(e) => setRelato(e.target.value)}
                  className={`${INPUT} resize-y`}
                />
              </div>

              <div className="border-t border-black/10 pt-4">
                <p className="m-0 text-sm font-bold">Seus dados</p>
                <p className="mt-1 mb-0 text-[0.8rem] text-black/60">
                  Só para a equipe falar com você se precisar. Não aparecem em lugar nenhum.
                </p>
              </div>

              <div>
                <label htmlFor={`${uid}-nome`} className={LABEL}>
                  Seu nome
                </label>
                <input
                  id={`${uid}-nome`}
                  data-field="nome"
                  autoComplete="name"
                  maxLength={80}
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  className={INPUT}
                  aria-invalid={!!errors.nome}
                  aria-describedby={errors.nome ? `${uid}-nome-err` : undefined}
                />
                {err("nome")}
              </div>

              <div>
                <label htmlFor={`${uid}-whatsapp`} className={LABEL}>
                  Seu WhatsApp
                </label>
                <PhoneInput
                  id={`${uid}-whatsapp`}
                  data-field="whatsapp"
                  international
                  defaultCountry="BR"
                  countryCallingCodeEditable={false}
                  limitMaxLength
                  flags={flags}
                  value={whatsapp}
                  onChange={setWhatsapp}
                  placeholder="(11) 90000-0000"
                  className="dg-phone"
                  aria-invalid={!!errors.whatsapp}
                  aria-describedby={errors.whatsapp ? `${uid}-whatsapp-err` : undefined}
                />
                {err("whatsapp")}
              </div>

              {/* Isca para robô: escondido de gente e de leitor de tela. */}
              <div aria-hidden="true" className="absolute left-[-9999px] h-px w-px overflow-hidden">
                <label htmlFor={`${uid}-empresa`}>Empresa</label>
                <input
                  id={`${uid}-empresa`}
                  tabIndex={-1}
                  autoComplete="off"
                  value={empresa}
                  onChange={(e) => setEmpresa(e.target.value)}
                />
              </div>
            </div>

            {formError && (
              <p className="mt-4 mb-0 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">
                {formError} Se preferir, fale com o {suporte}.
              </p>
            )}

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || lendoPrint}
              className="mt-5 w-full rounded-xl bg-[var(--dg-primary)] py-3.5 text-base font-bold text-white transition-colors hover:bg-[var(--dg-primary-hover)] disabled:opacity-60"
            >
              {submitting ? "Enviando..." : "Enviar denúncia"}
            </button>
            <p className="mt-3 mb-0 text-center text-[0.75rem] text-black/55">
              <a href={MARCA.privacidadeHref} className="underline underline-offset-2">
                Política de privacidade
              </a>
            </p>
          </div>
        )}

        <p className="mt-6 text-sm leading-relaxed text-white/70">
          {MARCA.verificacaoHref && (
            <>
              📌 Na dúvida se um número é nosso?{" "}
              <a className="font-bold text-white underline" href={MARCA.verificacaoHref}>
                Confira aqui
              </a>
              .{" "}
            </>
          )}
          Ninguém da equipe pede senha, código por SMS ou pagamento fora das páginas oficiais.
        </p>
      </div>
    </main>
  );
}
