// ============================================================
// Nó "Decide" do workflow de denúncia de golpe.
//
// Recebe a denúncia do site e decide, ANTES de qualquer chamada ao SendFlow, o que fazer.
// O webhook já respondeu 403 se o cabeçalho X-Webhook-Token não bateu.
//
// Este workflow é curto de propósito (Webhook → Decide → Responde → Executa): o n8n só grava
// a memória ($getWorkflowStaticData) quando a execução termina. Se o bloqueio, a remoção e a
// espera de conferência rodassem aqui, cada execução levaria mais de um minuto e denúncias
// simultâneas não se enxergariam: o disjuntor não seguraria uma rajada. O trabalho pesado
// fica no workflow "<nome>-execucao", chamado sem esperar.
//
//   oficial    número da lista `protegidos`: nunca bloqueia
//   repetido   já mandado bloquear nos últimos N minutos: não chama o SendFlow de novo
//   pausado    disjuntor (muitos bloqueios na última hora), modo aprovação ou dado inválido:
//              só manda o e-mail, alguém bloqueia à mão
//   bloqueado  segue para bloquear e tirar dos grupos
//
// O build.py troca /*__CONFIG__*/ pelo conteúdo do config.json. Edite AQUI e rode o build,
// nunca no editor do n8n (o próximo --push sobrescreve).
// ============================================================

const CFG = /*__CONFIG__*/ {};

const PARA = CFG.email_para;
const CLIENTES = CFG.clientes || {};
const PROTEGIDOS_RAW = CFG.protegidos || [];
// Só `true` liga o automático: chave ausente, "false" em texto ou qualquer outro valor = modo aprovação.
const AUTOMATICO = CFG.bloqueio_automatico === true;
const LIMITE_POR_HORA = CFG.limite_por_hora || 10;
const REPETIDO_MS = (CFG.repetido_minutos || 60) * 60 * 1000;
const GUARDA_MS = 30 * 24 * 3600 * 1000;

const so = (s) => String(s || '').replace(/\D/g, '');

/**
 * Grafias do mesmo número no WhatsApp. Celular brasileiro existe com e sem o 9: conta antiga
 * tem o JID sem ele, então bloquear uma grafia só deixa a outra passar.
 */
function variantes(dig) {
  const d = so(dig);
  if (!d) return [];
  const out = new Set([d]);
  if (d.startsWith('55')) {
    const nac = d.slice(2);
    if (nac.length === 11 && nac[2] === '9') out.add('55' + nac.slice(0, 2) + nac.slice(3));
    else if (nac.length === 10 && /[6-9]/.test(nac[2])) out.add('55' + nac.slice(0, 2) + '9' + nac.slice(2));
  }
  return [...out];
}

const body = $input.first().json.body || {};
const agora = Date.now();
const dry = body.dry === true;
const cliente = CLIENTES[body.client];
const sus = so(body.suspeito);
const vars = variantes(sus);
const protegidos = new Set(PROTEGIDOS_RAW.flatMap(variantes));

// Memória do workflow. Só persiste em execução de produção (webhook com o workflow ativo).
// `bloqueadoEm` marca quando o bloqueio foi MANDADO: se o SendFlow recusar, a próxima denúncia
// depois da janela de `repetido_minutos` tenta de novo (e o e-mail já avisou da falha).
const st = $getWorkflowStaticData('global');
st.denuncias = st.denuncias || {};
st.bloqueios = (st.bloqueios || []).filter((t) => agora - t < 3600 * 1000);
for (const [k, v] of Object.entries(st.denuncias)) if (agora - v.ultima > GUARDA_MS) delete st.denuncias[k];

const anterior = st.denuncias[sus];
let status;
let motivo = null;
if (!cliente) {
  status = 'pausado';
  motivo = `cliente desconhecido: ${body.client}`;
} else if (sus.length < 8 || sus.length > 15) {
  status = 'pausado';
  motivo = 'número inválido';
} else if (vars.some((v) => protegidos.has(v))) {
  status = 'oficial';
  motivo = 'número da lista de protegidos';
} else if (anterior && anterior.bloqueadoEm && agora - anterior.bloqueadoEm < REPETIDO_MS) {
  status = 'repetido';
} else if (!AUTOMATICO) {
  status = 'pausado';
  motivo = 'modo aprovação: conferir e bloquear à mão';
} else if (!dry && st.bloqueios.length >= LIMITE_POR_HORA) {
  status = 'pausado';
  motivo = `disjuntor: ${st.bloqueios.length} bloqueios na última hora`;
} else {
  status = 'bloqueado';
}

// Teste não mexe na memória: senão o dry-run marcaria o número como já bloqueado.
let vezes = (anterior ? anterior.vezes : 0) + 1;
if (!dry && sus) {
  const reg = st.denuncias[sus] || { vezes: 0, primeira: agora };
  reg.vezes += 1;
  reg.ultima = agora;
  if (status === 'bloqueado') {
    reg.bloqueadoEm = agora;
    st.bloqueios.push(agora);
  }
  st.denuncias[sus] = reg;
  vezes = reg.vezes;
}

const den = body.denunciante || {};
return [
  {
    json: {
      status,
      motivo,
      dry,
      para: PARA,
      cliente: body.client,
      rotulo: cliente ? cliente.rotulo : body.client,
      sigla: cliente ? cliente.sigla : '?',
      cor: cliente && cliente.cor ? cliente.cor : null,
      releases: cliente ? cliente.releases || [] : [],
      suspeito: sus ? `+${sus}` : '',
      variantes: vars,
      vezes,
      denunciante: { nome: String(den.nome || ''), whatsapp: String(den.whatsapp || '') },
      link: body.link || null,
      relato: body.relato || null,
      temPrint: !!(body.print && body.print.base64),
      print: body.print && body.print.base64 ? body.print : null,
      recebidoEm: body.receivedAt || new Date(agora).toISOString(),
      page: body.page || null,
      ip: body.ip || null,
      ua: body.ua || null,
    },
  },
];
