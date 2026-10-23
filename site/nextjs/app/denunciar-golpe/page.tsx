import type { Metadata } from "next";
import DenunciaGolpe from "@/components/denuncia/DenunciaGolpe";
import { MARCA } from "@/lib/denuncia-golpe";

// Página utilitária: fora do Google pelo `noindex` abaixo e fora do sitemap. NÃO ponha Disallow no
// robots para esta rota: rota bloqueada não é rastreada, o Google nunca lê o noindex e a URL pode
// ser indexada por link externo. Ninguém chega aqui pela busca: o link vai no onboarding dos grupos.
const TITLE = `Denunciar golpe | ${MARCA.nome}`;
const DESCRIPTION = `Recebeu mensagem de alguém se passando pela equipe de ${MARCA.nome}? Denuncie o número aqui.`;

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: TITLE,
  description: DESCRIPTION,
  // ⚠️ Se você declarar `openGraph` aqui, repita `images`: o merge de metadata do Next é raso
  // e o objeto da página APAGA o do layout (o link sai sem imagem no WhatsApp).
};

export default function Page() {
  return <DenunciaGolpe />;
}
