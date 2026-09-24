// Ajusta o pack até ele realmente abrir.
//
// O resolver escolhe "a versão mais nova de cada mod". Isso monta uma lista que
// parece certa e o Fabric recusa, porque cada jar traz exigências que a API das
// lojas não publica: faixas de versão ("Iris precisa de Sodium 0.6.x") e
// dependências que o autor não cadastrou ("Jewelry precisa de structure_pool_api").
//
// Aqui lemos essas exigências direto dos jars e mexemos no pack até que todas
// fechem: trocando versões, acrescentando o que falta, e — quando não existe
// combinação possível — dizendo com todas as letras quais dois mods não podem
// conviver, em vez de deixar o erro aparecer só na hora de jogar.

import { lerMetadados, MODS_DO_AMBIENTE } from './jarmeta.mjs';
import { satisfaz, comparar, descreverExigencia } from './versoes.mjs';

// Orçamento de passos do ajuste. Cada dependência descoberta e cada troca de
// versão gasta um passo, e um pack de 30 mods gasta dezenas.
// Configurável para que o caminho do orçamento esgotado possa ser testado.
const ORCAMENTO = Number(process.env.MPF_ORCAMENTO) || 120;
const CANDIDATAS_POR_MOD = 12;
// Se o mesmo mod já foi trocado tantas vezes, as regras estão se contradizendo
// e insistir vira laço infinito.
const TROCAS_POR_MOD = 6;

/** O Fabric API traz seus submódulos embutidos como jars aninhados. */
const ehSubmoduloDoFabricApi = (modid) => /^fabric-.+-v\d+$/.test(modid) || modid === 'fabric-api-base';

/**
 * modid -> { registro, versao }.
 *
 * A versão é a daquele modid, não a do jar que o entrega: um pacote como o
 * Fabric API carrega submódulos com numeração própria, e comparar a faixa
 * pedida contra a versão do pacote compararia coisas diferentes.
 */
function indexarPorModId(registros) {
  const indice = new Map();
  for (const r of registros) {
    if (!r.meta?.modId) continue;
    const versaoDe = (id) => r.meta.versaoDe?.[id] ?? r.meta.versao;
    indice.set(r.meta.modId, { registro: r, versao: versaoDe(r.meta.modId) });
    for (const fornecido of r.meta.fornece ?? []) {
      if (!indice.has(fornecido)) indice.set(fornecido, { registro: r, versao: versaoDe(fornecido) });
    }
  }
  return indice;
}

function ignoravel(modid, indice) {
  if (MODS_DO_AMBIENTE.has(modid)) return true;
  // Submódulo do Fabric API: agora que lemos os jars embutidos, o próprio
  // submódulo aparece no índice com a versão correta e a faixa é conferida de
  // verdade. Esta regra só age quando a leitura do embutido falhou — aí é mais
  // sensato assumir que ele veio junto do que acusar falta de algo que veio.
  if (ehSubmoduloDoFabricApi(modid) && indice.has('fabric-api') && !indice.has(modid)) return true;
  return false;
}

async function anexarMetadados(registros) {
  await Promise.all(
    registros.map(async (r) => {
      if (r.meta !== undefined) return;
      r.meta = await lerMetadados(r.arquivo?.url, r.arquivo?.tamanho);
    }),
  );
}

/**
 * Junta tudo que o pack exige de um mod: faixas de quem depende dele e faixas
 * proibidas de quem o quebra.
 */
function exigenciasSobre(modid, registros, exceto) {
  const precisa = [];
  const proibido = [];
  for (const outro of registros) {
    if (outro === exceto || !outro.meta) continue;
    const dep = outro.meta.depende?.[modid];
    if (dep != null && String(dep) !== '*') {
      precisa.push({ faixa: dep, de: outro.nome, registro: outro, dialeto: outro.meta.dialeto });
    }
    const quebra = outro.meta.quebra?.[modid];
    if (quebra != null) {
      proibido.push({ faixa: quebra, de: outro.nome, registro: outro, dialeto: outro.meta.dialeto });
    }
  }
  return { precisa, proibido };
}

/** Troca o arquivo de um registro pelo de outra versão. */
function aplicarVersao(registro, candidata, meta) {
  registro.versaoId = candidata.id;
  registro.versaoNumero = candidata.numero;
  registro.canal = candidata.canal;
  registro.arquivo = candidata.arquivo;
  registro.distribuicaoLiberada =
    candidata.distribuicaoLiberada !== false && Boolean(candidata.arquivo?.url);
  registro.meta = meta;
  registro.ajustado = true;
}

async function candidatasDe(registro, listarVersoes) {
  return (await listarVersoes(registro.fonte, registro.projetoId))
    .filter((v) => v.arquivo?.url)
    .sort((a, b) => comparar(b.numero, a.numero))
    .slice(0, CANDIDATAS_POR_MOD);
}

/**
 * Último recurso antes de desistir: em vez de mexer no mod encurralado, mexer
 * em quem o encurralou.
 *
 * Exemplo real: o Iris novo puxa o Sodium 0.8, e o Sodium 0.8 declara que não
 * funciona com o Better End. O Better End não tem versão mais nova, então não há
 * o que fazer por ele — mas existe um Sodium 0.6 que convive com os dois, e é o
 * Sodium que precisa ceder.
 */
async function cederQuemExige(encurralado, exigencias, registros, listarVersoes) {
  const modid = encurralado.meta?.modId;
  const versaoAtual = encurralado.meta?.versao ?? encurralado.versaoNumero;
  if (!modid) return null;

  const culpados = [...new Set([...exigencias.precisa, ...exigencias.proibido].map((p) => p.registro))];

  for (const culpado of culpados) {
    for (const candidata of await candidatasDe(culpado, listarVersoes)) {
      if (candidata.id === culpado.versaoId) continue;
      const meta = await lerMetadados(candidata.arquivo.url, candidata.arquivo.tamanho);
      if (!meta) continue;

      const exige = meta.depende?.[modid];
      if (exige != null && !satisfaz(versaoAtual, exige, meta.dialeto)) continue;
      const quebra = meta.quebra?.[modid];
      if (quebra != null && satisfaz(versaoAtual, quebra, meta.dialeto)) continue;
      if (criaConflitoNovo(meta, registros, culpado)) continue;

      const de = culpado.versaoNumero;
      aplicarVersao(culpado, candidata, meta);
      return {
        nome: culpado.nome,
        de,
        para: candidata.numero,
        porque: `é a versão que convive com ${encurralado.nome} ${versaoAtual}`,
      };
    }
  }
  return null;
}

function versaoAtende(versaoTexto, { precisa, proibido }) {
  for (const p of precisa) if (!satisfaz(versaoTexto, p.faixa, p.dialeto)) return false;
  for (const p of proibido) if (satisfaz(versaoTexto, p.faixa, p.dialeto)) return false;
  return true;
}

/**
 * @param {object} entrada
 * @param {Array} entrada.registros           mods já resolvidos
 * @param {Function} entrada.listarVersoes    (fonte, projetoId) => versões compatíveis
 * @param {Function} entrada.acharPorModId    (modid) => registro novo ou null
 */
export async function ajustar({ registros, listarVersoes, acharPorModId }) {
  const trocas = [];
  const adicionados = [];
  const problemas = [];
  const modIdsProcurados = new Set();
  const naoEncontrados = new Set();
  const trocasPorMod = new Map(); // impede ficar trocando o mesmo mod pra sempre

  await anexarMetadados(registros);

  let passos = 0;
  let esgotouOrcamento = false;

  while (true) {
    // Cada dependência descoberta e cada troca de versão gastam um passo. Um
    // pack grande com árvore de dependências profunda gasta dezenas deles, e
    // antes o limite era baixo o bastante para acabar antes da fase que
    // conserta versões.
    if (passos++ >= ORCAMENTO) {
      esgotouOrcamento = true;
      break;
    }
    let mexeu = false;
    const indice = indexarPorModId(registros);

    // ---- 1. o que está faltando ------------------------------------------
    const faltantes = new Map(); // modid -> [{ faixa, de }]
    for (const r of registros) {
      for (const [modid, faixa] of Object.entries(r.meta?.depende ?? {})) {
        if (indice.has(modid) || ignoravel(modid, indice)) continue;
        if (!faltantes.has(modid)) faltantes.set(modid, []);
        faltantes.get(modid).push({ faixa, de: r.nome });
      }
    }

    for (const [modid, quemPede] of faltantes) {
      if (modIdsProcurados.has(modid)) continue;
      modIdsProcurados.add(modid);

      const novo = await acharPorModId(modid, quemPede);
      if (novo) {
        novo.origem = 'dependencia';
        novo.exigidoPor = [...new Set(quemPede.map((q) => q.de))];
        novo.meta = await lerMetadados(novo.arquivo?.url, novo.arquivo?.tamanho);
        registros.push(novo);
        adicionados.push({ nome: novo.nome, modid, exigidoPor: novo.exigidoPor });
        mexeu = true;
      } else {
        naoEncontrados.add(modid);
      }
    }
    if (mexeu) continue; // reavalia com os novos mods no bolo

    // ---- 2. versões que não fecham ---------------------------------------
    for (const r of registros) {
      const modid = r.meta?.modId;
      if (!modid || !r.meta?.versao) continue;

      const exigencias = exigenciasSobre(modid, registros, r);
      if (!exigencias.precisa.length && !exigencias.proibido.length) continue;
      if (versaoAtende(r.meta.versao, exigencias)) continue;
      if ((trocasPorMod.get(r.chave) ?? 0) >= TROCAS_POR_MOD) continue;

      // Procura outra versão deste mesmo mod que atenda a todo mundo.
      const candidatas = await candidatasDe(r, listarVersoes);

      let escolhida = null;
      for (const candidata of candidatas) {
        const meta = await lerMetadados(candidata.arquivo.url, candidata.arquivo.tamanho);
        const versaoTexto = meta?.versao ?? candidata.numero;
        if (!versaoAtende(versaoTexto, exigencias)) continue;
        // A troca não pode criar um problema novo com o resto do pack.
        if (meta && criaConflitoNovo(meta, registros, r)) continue;
        escolhida = { candidata, meta };
        break;
      }

      if (escolhida) {
        trocas.push({
          nome: r.nome,
          de: r.versaoNumero,
          para: escolhida.candidata.numero,
          porque: exigencias.precisa
            .map((p) => `${p.de} exige ${descreverExigencia(p.faixa)}`)
            .concat(exigencias.proibido.map((p) => `${p.de} não funciona com ${descreverExigencia(p.faixa)}`))
            .join('; '),
        });
        aplicarVersao(r, escolhida.candidata, escolhida.meta);
        trocasPorMod.set(r.chave, (trocasPorMod.get(r.chave) ?? 0) + 1);
        mexeu = true;
        break; // recomeça a rodada com o pack já mexido
      }

      // Nenhuma versão deste mod serve. Antes de desistir, tenta fazer quem
      // exige ceder — muitas vezes é o outro lado que tem folga.
      const cedeu = await cederQuemExige(r, exigencias, registros, listarVersoes);
      if (cedeu) {
        trocas.push(cedeu);
        mexeu = true;
        break;
      }

      // Nada a fazer por este mod nesta passada. A auditoria final decide se
      // isso é um problema de verdade — pode ser que outra troca resolva.
    }
    if (mexeu) continue;

    break; // estabilizou: nada mais a mexer
  }

  // AUDITORIA FINAL — roda sempre, inclusive quando o orçamento acabou.
  //
  // Antes, quando o laço estourava o limite de rodadas, a função saía sem
  // conferir nada e o pack era dado como bom. Foi assim que um pack com o Iris
  // e o Sodium brigando passou direto e só quebrou na hora de jogar. Terminar
  // sem resposta nunca pode virar "está tudo certo".
  problemas.push(...auditar(registros, naoEncontrados));

  if (esgotouOrcamento) {
    problemas.push({
      tipo: 'nao-convergiu',
      texto:
        'O pack é grande demais para ajustar sozinho por completo. Os problemas acima ' +
        'são o que sobrou — resolva-os tirando algum mod.',
    });
  }

  // Dedup: a mesma dupla pode ser apontada pelos dois lados.
  const vistos = new Set();
  const unicos = problemas.filter((p) => {
    const chave = `${p.tipo}|${[p.nome, ...(p.comQuem ?? []), p.modid ?? ''].sort().join('|')}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });

  return { registros, trocas, adicionados, problemas: unicos };
}

/**
 * Confere o pack inteiro do zero, do jeito que o Fabric Loader confere ao abrir
 * o jogo: toda dependência tem que estar presente e na faixa pedida, e nenhum
 * "breaks" pode bater.
 *
 * Isto roda sempre, independente de o ajuste ter conseguido resolver tudo. É o
 * que garante que um pack quebrado nunca seja entregue como bom.
 */
function auditar(registros, naoEncontrados) {
  const problemas = [];
  const indice = indexarPorModId(registros);

  for (const r of registros) {
    if (!r.meta) continue;
    const versaoDeR = r.meta.versao ?? r.versaoNumero;

    for (const [modid, faixa] of Object.entries(r.meta.depende ?? {})) {
      if (ignoravel(modid, indice)) continue;
      const alvo = indice.get(modid);

      if (!alvo) {
        problemas.push({
          tipo: 'dependencia-nao-encontrada',
          modid,
          nome: r.nome,
          chave: r.chave,
          comQuem: [],
          texto: naoEncontrados.has(modid)
            ? `${r.nome} precisa de "${modid}", que não existe em nenhuma das lojas com esse nome.`
            : `${r.nome} precisa de "${modid}", que não está no pack.`,
        });
        continue;
      }

      const versaoAlvo = alvo.versao;
      if (!satisfaz(versaoAlvo, faixa, r.meta.dialeto)) {
        problemas.push({
          tipo: 'sem-versao-possivel',
          nome: r.nome,
          chave: r.chave,
          comQuem: [alvo.registro.nome],
          chaveOutro: alvo.registro.chave,
          texto:
            `${r.nome} ${versaoDeR} precisa de ${alvo.registro.nome} ${descreverExigencia(faixa)}, ` +
            `e o pack só consegue ${versaoAlvo}. Tire um dos dois.`,
        });
      }
    }

    for (const [modid, faixa] of Object.entries(r.meta.quebra ?? {})) {
      const alvo = indice.get(modid);
      if (!alvo || alvo.registro === r) continue;
      const versaoAlvo = alvo.versao;
      if (!satisfaz(versaoAlvo, faixa, r.meta.dialeto)) continue;
      problemas.push({
        tipo: 'incompativel-declarado',
        nome: r.nome,
        chave: r.chave,
        comQuem: [alvo.registro.nome],
        chaveOutro: alvo.registro.chave,
        texto: `${r.nome} ${versaoDeR} não funciona junto com ${alvo.registro.nome} ${versaoAlvo}.`,
      });
    }
  }
  return problemas;
}

/** A versão candidata quebra alguém que já está no pack? */
function criaConflitoNovo(meta, registros, exceto) {
  const indice = indexarPorModId(registros.filter((r) => r !== exceto));
  for (const [modid, faixa] of Object.entries(meta.quebra ?? {})) {
    const outro = indice.get(modid);
    if (!outro) continue;
    if (satisfaz(outro.versao, faixa, meta.dialeto)) return true;
  }
  return false;
}
