// ============================================================
// Nó "Monta e-mail" do workflow de denúncia de golpe.
//
// E-mail de conferência para a equipe, em TODA denúncia (inclusive oficial, repetida, teste,
// disjuntor e modo aprovação). Quando o bloqueio é automático, este e-mail é como a equipe
// confere depois e desfaz se for engano: links wa.me para falar com quem denunciou e para ver
// o perfil do número, o que a pessoa mandou, o print anexo e o resultado de cada chamada ao
// SendFlow.
//
// Chega aqui por três caminhos (sem SendFlow, remoção pulada, remoção conferida), então lê
// cada nó com try/catch: nó que não rodou nesta execução lança erro ao ser lido.
// ============================================================

const d = $('Recebe').first().json;
const COR = d.cor || '#e10098'; // clientes.<slug>.cor no config.json
const ler = (nome) => {
  try {
    return $(nome).all().map((i) => i.json);
  } catch (e) {
    return null;
  }
};
const bloqueios = ler('Bloqueia');
const itens = ler('Itens de remoção');
const remocoes = ler('Remove');
const conferencias = ler('Confere');

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const so = (s) => String(s || '').replace(/\D/g, '');
function fmt(e164) {
  const x = so(e164);
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(x);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${x}`;
}
const ok = (code) => code >= 200 && code < 300;
const trecho = (v) => esc(JSON.stringify(v == null ? '' : v).slice(0, 220));

// ---------- resultado do SendFlow ----------
const linhas = [];
let falhou = false;
if (bloqueios) {
  for (const b of bloqueios) {
    const numero = (b.body && b.body.number) || '?';
    if (b.error) {
      falhou = true;
      linhas.push(`❌ Bloqueio: erro de rede (${esc(String(b.error.message || b.error).slice(0, 160))})`);
    } else if (ok(b.statusCode)) {
      linhas.push(`✅ Bloqueado: ${esc(numero)}`);
    } else {
      falhou = true;
      linhas.push(`❌ Bloqueio respondeu ${b.statusCode}: ${trecho(b.body)}`);
    }
  }
}
if (itens && itens.length && itens[0].pular) {
  falhou = true;
  linhas.push(`⚠️ Remoção dos grupos NÃO foi feita: ${esc(itens[0].motivo)}`);
} else if (itens && remocoes) {
  itens.forEach((it, i) => {
    const r = remocoes[i] || {};
    const c = (conferencias && conferencias[i]) || null;
    let txt = `${esc(it.nome)}: `;
    if (r.error || !ok(r.statusCode)) {
      falhou = true;
      txt += `❌ ação recusada (${r.error ? 'erro de rede' : r.statusCode}) ${trecho(r.body)}`;
    } else if (!c || c.error || !ok(c.statusCode)) {
      txt += `🟡 ação criada, sem conferência (${c ? c.statusCode || 'erro' : 'não conferida'})`;
    } else {
      const a = c.body || {};
      if (a.success === true) txt += '✅ removido (ou não estava lá)';
      else if (a.processed === true) {
        falhou = true;
        txt += `❌ processada sem sucesso ${trecho(a.result || a.error || '')}`;
      } else txt += '🟡 ainda processando';
    }
    linhas.push(txt);
  });
}

// ---------- assunto ----------
const sus = fmt(d.suspeito);
let estado;
if (d.status === 'oficial') estado = 'oficial, NÃO bloqueado';
else if (d.status === 'repetido') estado = `repetido (${d.vezes}ª denúncia), já estava bloqueado`;
else if (d.status === 'pausado') estado = `NÃO bloqueado, conferir à mão (${d.motivo || 'pausado'})`;
else if (d.dry) estado = 'teste, nada feito no SendFlow';
else estado = falhou ? 'bloqueado com FALHA, conferir' : 'bloqueado e removido dos grupos';
const subject = `${d.dry ? '[TESTE] ' : ''}[Golpe][${d.sigla}] ${sus}: ${estado}`;

// ---------- links ----------
const den = d.denunciante || {};
const primeiro = String(den.nome || '').trim().split(/\s+/)[0] || '';
const msgDen =
  `Oi, ${primeiro}! Aqui é da equipe de ${d.rotulo}. Recebemos sua denúncia do número ${sus}, ` +
  'obrigado por avisar. Você chegou a pagar ou enviar algum dado para essa pessoa?';
const waDen = so(den.whatsapp) ? `https://wa.me/${so(den.whatsapp)}?text=${encodeURIComponent(msgDen)}` : null;
const waSus = so(d.suspeito) ? `https://wa.me/${so(d.suspeito)}` : null;
const botao = (href, txt, cor) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 16px;border-radius:10px;background:${cor};color:#fff;font-weight:bold;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:14px;">${txt}</a>`;

const P = 'margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#2b2326;';
const H = 'margin:22px 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1b0b17;';
const linha = (k, v) => `<tr><td style="padding:3px 12px 3px 0;color:#7a6a75;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:3px 0;color:#1b0b17;">${v}</td></tr>`;

const html = `<div style="background:#f4f2f2;padding:24px 12px;">
<div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;padding:26px 26px 18px;border-top:4px solid ${COR};">
${d.dry ? `<p style="${P}background:#fff6d6;padding:8px 12px;border-radius:8px;"><b>TESTE:</b> nada foi feito no SendFlow.</p>` : ''}
<p style="${P}font-size:16px;"><b>${esc(sus)}</b> foi denunciado na página de denúncia de ${esc(d.rotulo)}.</p>
<p style="${P}"><b>Status:</b> ${esc(estado)}</p>

<h3 style="${H}">Conferir</h3>
<p style="${P}">
${waSus ? botao(waSus, 'Ver o número denunciado', COR) : ''}
${waDen ? botao(waDen, `Falar com ${esc(primeiro || 'quem denunciou')}`, '#1f8f4e') : ''}
</p>
<p style="${P}color:#7a6a75;font-size:12px;">Abrir a conversa com o número denunciado não manda nada: só mostra nome e foto do perfil.</p>

<h3 style="${H}">O que a pessoa mandou</h3>
<table style="border-collapse:collapse;font-family:Helvetica,Arial,sans-serif;font-size:14px;">
${linha('Denunciado', esc(sus))}
${linha('Grafias', esc((d.variantes || []).join(', ')))}
${linha('Quem denunciou', `${esc(den.nome)} · ${esc(fmt(den.whatsapp))}`)}
${linha('Link recebido', d.link ? esc(d.link) + ' <span style="color:#b00020;">(não abrir)</span>' : 'não informado')}
${linha('Relato', d.relato ? esc(d.relato) : 'não informado')}
${linha('Print', d.temPrint ? 'anexo neste e-mail' : 'não enviado')}
${linha('Denúncias deste número', String(d.vezes))}
${linha('Recebido em', esc(new Date(d.recebidoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })))}
</table>

${linhas.length ? `<h3 style="${H}">SendFlow</h3><p style="${P}">${linhas.join('<br>')}</p>` : ''}

<h3 style="${H}">Se foi engano</h3>
<p style="${P}">1. Painel do SendFlow, anti-spam (números bloqueados): remover ${esc((d.variantes || []).join(' e '))}. A API não desbloqueia.<br>
2. Se for alguém de verdade da comunidade, mande de novo o link do grupo.</p>
<p style="${P}color:#7a6a75;font-size:12px;">O bloqueio vale para a conta inteira do SendFlow (todos os projetos). Número oficial nunca é bloqueado: a lista fica em protegidos, no config.json do workflow. Depois de um bloqueio, novas denúncias do mesmo número ficam como repetidas pela janela de repetido_minutos.<br>IP ${esc(d.ip)} · ${esc(d.page)}</p>
</div></div>`;

const out = { json: { to: d.para, subject, html } };
const print = d.print;
if (print && print.base64) {
  const ext = String(print.mime || 'image/jpeg').split('/')[1] || 'jpg';
  out.binary = {
    print: await this.helpers.prepareBinaryData(
      Buffer.from(print.base64, 'base64'),
      `print-denuncia.${ext === 'jpeg' ? 'jpg' : ext}`,
      print.mime || 'image/jpeg',
    ),
  };
}
return [out];
