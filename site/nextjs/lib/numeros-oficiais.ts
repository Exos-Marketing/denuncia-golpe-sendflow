/**
 * Números oficiais da equipe. ADAPTE: troque os exemplos pelos seus (suporte, comercial,
 * chip de disparo do SendFlow, admins dos grupos, número da API oficial do WhatsApp).
 *
 * Esta lista faz a página responder "esse número é nosso" sem chamar o n8n. A proteção que
 * vale de verdade é a lista `protegidos` do config.json do workflow: mantenha as duas iguais.
 * Número de equipe que ficar de fora pode ser bloqueado na conta inteira do SendFlow por uma
 * denúncia falsa.
 */
export type NumeroOficial = { numero: string; papel: string };

export const NUMEROS_OFICIAIS: NumeroOficial[] = [
  { numero: "+55 11 0000-0001", papel: "Suporte oficial" },
  { numero: "+55 11 90000-0002", papel: "Avisos e administração dos grupos" },
];

const digits = (s: string) => s.replace(/\D/g, "");

/** Formas aceitas de um número: completo, sem o 55 do Brasil e (celular BR) sem o 9 extra. */
export function formas(n: string): string[] {
  const d = digits(n);
  const out = new Set([d]);
  if (d.startsWith("55") && d.length >= 12) {
    const nac = d.slice(2);
    out.add(nac);
    if (nac.length === 11 && nac[2] === "9") out.add(nac.slice(0, 2) + nac.slice(3)); // sem o 9
  }
  return [...out];
}

const OFICIAIS = NUMEROS_OFICIAIS.map((o) => ({ ...o, formas: formas(o.numero) }));

/**
 * Papel do número na equipe, ou null se não for nosso. Comparação EXATA pelos dígitos (com ou
 * sem +55, com ou sem o 9). "Contém" aceitaria pedaço de número e daria falso positivo.
 *
 * Sem "+" na frente, 10 ou 11 dígitos são lidos como BR sem o 55 E como estão, porque
 * "1 213 555 0100" (EUA) também tem 11 dígitos.
 */
export function papelOficial(entrada: string): string | null {
  const d = digits(entrada);
  if (d.length < 10) return null;
  const internacional = entrada.trim().startsWith("+");
  const candidatos = new Set(formas(d));
  if (!internacional && (d.length === 10 || d.length === 11)) formas(`55${d}`).forEach((f) => candidatos.add(f));
  const hit = OFICIAIS.find((o) => o.formas.some((f) => candidatos.has(f)));
  return hit ? hit.papel : null;
}
