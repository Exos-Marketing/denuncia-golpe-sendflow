/**
 * Denúncia de número golpista: configuração do site.
 *
 * A página (/denunciar-golpe/) manda a denúncia para a rota /api/denuncia-golpe/, que
 * repassa ao workflow do n8n. É o n8n que bloqueia o número no SendFlow, tira dos grupos e
 * manda o e-mail de conferência para a equipe.
 *
 * ADAPTE AQUI: nome da marca, links, cores e o slug que casa com `clientes` no
 * config.json do workflow. Nada neste arquivo é segredo (ele vai para o navegador).
 *
 * Variáveis de ambiente (só no servidor, nunca NEXT_PUBLIC_):
 *   GOLPE_WEBHOOK_URL    URL de produção do webhook do n8n
 *   GOLPE_WEBHOOK_TOKEN  segredo enviado no cabeçalho X-Webhook-Token (o mesmo da credencial do webhook)
 *   GOLPE_DRY_RUN=1      só em teste: o n8n não chama o SendFlow e o e-mail sai [TESTE]
 */

/** Rota da página. Com `trailingSlash: false` no next.config, tire a barra final. */
export const DENUNCIA_PATH = "/denunciar-golpe/";
/** Rota da API, chamada pela página. */
export const DENUNCIA_API = "/api/denuncia-golpe/";

/** Slug da marca no n8n: chave em `clientes` do config.json. Escolhe de quais campanhas o número sai. */
export const GOLPE_CLIENT = "minha-marca";

export const MARCA = {
  /** Como a marca aparece no topo e nos textos ("se passando pela {nome}"). */
  nome: "Minha Marca",
  /** Link de suporte oficial (ideal: uma rota do seu domínio que redireciona ao WhatsApp). */
  suporteHref: "/suporte/",
  privacidadeHref: "/politica-de-privacidade/",
  /** Página onde a pessoa confere se um número é oficial, ou null se você não tiver uma. */
  verificacaoHref: null as string | null,
};

/** Cores da página. Viram variáveis CSS (--dg-*) no componente. */
export const CORES = {
  fundo: "#1b0b17",
  destaque: "#e10098",
  destaqueHover: "#c00083",
  sobretitulo: "#ff4fa3",
};

/** Print já reduzido no navegador (JPEG até 1600px). ~2 MB de imagem em base64. */
export const PRINT_MAX_BASE64 = 2_800_000;
export const RELATO_MAX = 500;
export const LINK_MAX = 500;

/** Como o n8n classificou a denúncia (a resposta sai antes de chamar o SendFlow). */
export type DenunciaStatus = "bloqueado" | "repetido" | "oficial" | "pausado";

/**
 * Plugue aqui o seu pixel para o clique no suporte (ex.: Meta `Contact`). Não dispare `Lead`
 * no envio da denúncia: não é captação, e o número do golpista não deve ir para o pixel.
 */
export function rastrearSuporte(): void {
  // ex.: (window as unknown as { fbq?: (...a: unknown[]) => void }).fbq?.("track", "Contact");
}

/**
 * E.164 plausível: "+" e 8 a 15 dígitos; no Brasil, DDD + 8 (fixo) ou 9 (celular, começando
 * com 9). A página já valida com `isValidPhoneNumber`; isto é a segunda barreira do servidor,
 * sem puxar a biblioteca de React para dentro da rota.
 */
export function e164Plausivel(v: string): boolean {
  if (!/^\+[1-9]\d{7,14}$/.test(v)) return false;
  const m = /^\+55(\d{2})(\d+)$/.exec(v);
  if (!m) return true;
  const resto = m[2];
  return resto.length === 8 || (resto.length === 9 && resto.startsWith("9"));
}
