// ============================================================
// Nó "Itens de remoção" do workflow de denúncia de golpe.
//
// Recebe as respostas do bloqueio (uma por grafia do número) e monta um item por campanha
// da marca para o POST /actions/remove-participants.
//
// Para tudo no primeiro 401, 403, 429, 5xx ou erro de rede. No SendFlow, 403 é "Limite de operações
// atingido!" e violações repetidas em poucos minutos bloqueiam a CHAVE inteira por horas.
// Insistir é o que transforma um limite leve em chave bloqueada. Nesse caso o e-mail avisa e
// a equipe termina à mão.
// ============================================================

const d = $('Recebe').first().json;
const bloqueios = $input.all().map((i) => i.json);

const falha = bloqueios.find((b) => b.error || [401, 403, 429].includes(b.statusCode) || b.statusCode >= 500);
if (falha) {
  const motivo = falha.error
    ? `erro de rede no bloqueio: ${String(falha.error.message || falha.error).slice(0, 200)}`
    : `bloqueio respondeu ${falha.statusCode}: ${JSON.stringify(falha.body).slice(0, 200)}`;
  return [{ json: { pular: true, motivo } }];
}
if (!d.releases.length) return [{ json: { pular: true, motivo: 'nenhuma campanha configurada para a marca' } }];

return d.releases.map((r) => ({
  json: { pular: false, releaseId: r.id, nome: r.nome, participants: d.variantes },
}));
