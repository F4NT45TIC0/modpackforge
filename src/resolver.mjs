// Monta o plano final do pack: resolve dependências em largura, escolhe o arquivo
// de cada mod e cruza tudo contra as regras de conflito.

import * as modrinth from './modrinth.mjs';
import * as curseforge from './curseforge.mjs';
import { checarCandidato } from './conflitos.mjs';
import { ajustar } from './compatibilidade.mjs';
import { lerMetadados } from './jarmeta.mjs';
import { mesmoMod } from '../web/compartilhado/conflitos.mjs';

const PROVIDERS = { modrinth, curseforge };

const PROFUNDIDADE_MAXIMA = 6;

export const chaveDe = (fonte, projetoId) => `${fonte}:${projetoId}`;

/** A mais nova entre as compatíveis, preferindo release a beta/alpha. */
export function melhorVersao(lista, { loader, mc }) {
  const compativeis = lista.filter((v) => {
    if (!v.arquivo) return false;
    if (mc && v.versoesJogo.length && !v.versoesJogo.includes(mc)) return false;
    // Arquivos antigos da CurseForge às vezes não marcam loader nenhum.
    if (loader && v.loaders.length) {
      const aceitos = loader === 'quilt' ? ['quilt', 'fabric'] : [loader];
      if (!v.loaders.some((l) => aceitos.includes(l))) return false;
    }
    return true;
  });
  if (!compativeis.length) return null;
  const porData = [...compativeis].sort((a, b) => new Date(b.publicado) - new Date(a.publicado));
  return porData.find((v) => v.canal === 'release') ?? porData[0];
}

/**
 * Junta os pedidos repetidos de uma mesma rodada antes de resolver.
 *
 * Sem isso, dois mods que dependem do mesmo terceiro viram duas chamadas em
 * paralelo e a que terminar primeiro define a versão — o que faz o mesmo pack
 * gerar arquivos diferentes a cada execução. Aqui o pedido é único, a versão
 * fixada por quem depende tem prioridade sobre a escolha automática, e a ordem
 * é estável.
 */
function agruparPedidos(pedidos) {
  const porChave = new Map();
  for (const pedido of pedidos) {
    const chave = chaveDe(pedido.fonte, pedido.projetoId);
    const existente = porChave.get(chave);
    if (!existente) {
      porChave.set(chave, { ...pedido, exigidoPor: [...pedido.exigidoPor] });
      continue;
    }
    for (const quem of pedido.exigidoPor) {
      if (!existente.exigidoPor.includes(quem)) existente.exigidoPor.push(quem);
    }
    if (pedido.origem === 'escolhido') existente.origem = 'escolhido';
    if (pedido.versaoId && !existente.versaoId) existente.versaoId = pedido.versaoId;
    existente.profundidade = Math.min(existente.profundidade, pedido.profundidade);
  }
  return [...porChave.values()].sort((a, b) =>
    a.fonte === b.fonte ? a.projetoId.localeCompare(b.projetoId) : a.fonte.localeCompare(b.fonte),
  );
}

/**
 * Acha na loja o mod que responde por um modid declarado dentro de um jar.
 *
 * O modid não é o slug da loja, então tentamos o caminho barato (slug igual, com
 * as trocas usuais entre traço e sublinhado) e só depois caímos na busca por
 * texto. Em todos os casos a confirmação é a mesma: abrir o jar candidato e ver
 * se o modid bate de verdade — senão acabaríamos instalando um mod homônimo.
 */
async function acharPorModId(modid, alvo) {
  const confere = async (projetoId, fonte = 'modrinth') => {
    const provider = PROVIDERS[fonte];
    const versoes = await provider.versoes(projetoId, alvo).catch(() => []);
    const versao = melhorVersao(versoes, alvo);
    if (!versao?.arquivo?.url) return null;
    const meta = await lerMetadados(versao.arquivo.url, versao.arquivo.tamanho, alvo.loader);
    const bate = meta?.modId === modid || (meta?.fornece ?? []).includes(modid);
    if (!bate) return null;
    const projeto = await provider.projeto(projetoId).catch(() => null);
    return montarRegistro(projeto, versao, meta, fonte);
  };

  const tentativas = [modid, modid.replace(/_/g, '-'), modid.replace(/-/g, '_')];
  for (const slug of [...new Set(tentativas)]) {
    try {
      const achado = await confere(slug);
      if (achado) return achado;
    } catch {
      // slug inexistente é o caso comum; segue para o próximo
    }
  }

  // Último recurso: busca textual, conferindo cada candidato pelo modid do jar.
  try {
    const { itens } = await modrinth.buscar({
      consulta: modid.replace(/[_-]/g, ' '),
      loader: alvo.loader,
      mc: alvo.mc,
      limite: 5,
    });
    for (const item of itens) {
      const achado = await confere(item.id);
      if (achado) return achado;
    }
  } catch {
    // sem resultado utilizável
  }
  if (await curseforge.temChave()) {
    const resultado = await curseforge.buscar({ consulta: modid.replace(/[_-]/g, ' '), loader: alvo.loader, mc: alvo.mc, limite: 5 }).catch(() => ({ itens: [] }));
    for (const item of resultado.itens) {
      const achado = await confere(item.id, 'curseforge');
      if (achado) return achado;
    }
  }
  return null;
}

function montarRegistro(projeto, versao, meta, fonte = 'modrinth') {
  return {
    chave: chaveDe(fonte, versao.projetoId),
    fonte,
    projetoId: versao.projetoId,
    versaoId: versao.id,
    versaoNumero: versao.numero,
    canal: versao.canal,
    arquivo: versao.arquivo,
    distribuicaoLiberada: versao.distribuicaoLiberada !== false && Boolean(versao.arquivo?.url),
    paginaDoArquivo: versao.paginaDoArquivo ?? null,
    origem: 'dependencia',
    exigidoPor: [],
    fixado: false,
    incompativeis: [],
    opcionais: [],
    meta,
    nome: projeto?.nome ?? versao.projetoId,
    slug: projeto?.slug ?? null,
    icone: projeto?.icone ?? null,
    pagina: projeto?.pagina ?? null,
    resumo: projeto?.resumo ?? '',
    ladoCliente: projeto?.ladoCliente ?? 'unknown',
    ladoServidor: projeto?.ladoServidor ?? 'unknown',
  };
}

async function obterVersao(fonte, projetoId, versaoId, alvo) {
  const p = PROVIDERS[fonte];
  if (!p) throw new Error(`Fonte desconhecida: ${fonte}`);

  if (versaoId) {
    const v = fonte === 'modrinth'
      ? await p.versaoPorId(versaoId)
      : await p.versaoPorId(projetoId, versaoId);
    if (String(v.projetoId) !== String(projetoId)) throw new Error('Versão não pertence ao projeto escolhido.');
    if (!melhorVersao([v], alvo)) throw new Error('Versão fixada não é compatível com o Minecraft e loader escolhidos.');
    return v;
  }
  const lista = await p.versoes(projetoId, alvo);
  return melhorVersao(lista, alvo);
}

// ------------------------------------------------------------------ shaders

/**
 * Quem carrega shaders, em ordem de preferência. O Iris cobre Fabric, Quilt e
 * NeoForge; o Oculus é o porte dele para Forge. Cada um lê a própria config,
 * que é onde a exportação deixa o shader já ativado.
 */
const CARREGADORES_DE_SHADER = [
  { id: 'iris', slug: 'iris', nome: 'Iris', config: 'iris.properties' },
  { id: 'oculus', slug: 'oculus', nome: 'Oculus', config: 'oculus.properties' },
];

async function carregadorDeShader(alvo) {
  for (const c of CARREGADORES_DE_SHADER) {
    const versoes = await modrinth.versoes(c.slug, alvo).catch(() => []);
    const versao = melhorVersao(versoes, alvo);
    if (versao) return { ...c, projetoId: String(versao.projetoId) };
  }
  return null;
}

/** Resolve os shaders escolhidos. Sem dependências: é um arquivo por shader. */
async function resolverShaders(pedidos, alvo) {
  const porPosicao = new Array(pedidos.length).fill(null);
  const faltando = [];
  const erros = [];

  await Promise.all(
    pedidos.map(async (pedido, i) => {
      try {
        if (pedido.fonte !== 'modrinth') throw new Error('Shaders vêm só da Modrinth por enquanto.');
        const versao = pedido.versaoId
          ? await modrinth.versaoPorId(pedido.versaoId)
          : modrinth.melhorVersaoShader(await modrinth.versoesShader(pedido.projetoId), alvo.mc);
        if (versao && versao.projetoId !== pedido.projetoId) throw new Error('Versão de shader não pertence ao projeto.');
        if (!versao?.arquivo?.url) {
          faltando.push({
            fonte: pedido.fonte,
            projetoId: pedido.projetoId,
            exigidoPor: [],
            motivo: 'Nenhuma versão deste shader roda no Iris.',
          });
          return;
        }
        const projetoId = String(versao.projetoId);
        porPosicao[i] = {
          chave: chaveDe('modrinth', projetoId),
          fonte: 'modrinth',
          projetoId,
          versaoId: versao.id,
          versaoNumero: versao.numero,
          canal: versao.canal,
          arquivo: versao.arquivo,
          distribuicaoLiberada: true,
          paginaDoArquivo: null,
          origem: 'escolhido',
          exigidoPor: [],
          fixado: Boolean(pedido.versaoId),
          incompativeis: [],
          opcionais: [],
        };
      } catch (erro) {
        erros.push({
          fonte: pedido.fonte,
          projetoId: pedido.projetoId,
          mensagem: erro.message,
          codigo: erro.codigo ?? null,
        });
      }
    }),
  );

  // Mantém a ordem em que o usuário escolheu: o primeiro é o que vem ativado.
  return { shaders: porPosicao.filter(Boolean), faltando, erros };
}

async function resolverRecursos(pedidos, alvo) {
  const porPosicao = new Array(pedidos.length).fill(null);
  const faltando = [];
  const erros = [];
  await Promise.all(pedidos.map(async (pedido, i) => {
    try {
      if (pedido.fonte !== 'modrinth') throw new Error('Pacotes de recursos vêm da Modrinth.');
      const versao = pedido.versaoId
        ? await modrinth.versaoPorId(pedido.versaoId)
        : modrinth.melhorVersao(await modrinth.versoesRecurso(pedido.projetoId, alvo.mc));
      if (versao && versao.projetoId !== pedido.projetoId) throw new Error('Versão de recursos não pertence ao projeto.');
      if (!versao?.arquivo?.url || !versao.arquivo.nome.endsWith('.zip')) {
        faltando.push({ fonte: pedido.fonte, projetoId: pedido.projetoId, exigidoPor: [], motivo: 'Nenhum .zip para esta versão do Minecraft.' });
        return;
      }
      const projetoId = String(versao.projetoId);
      porPosicao[i] = {
        chave: chaveDe('modrinth', projetoId), fonte: 'modrinth', projetoId,
        versaoId: versao.id, versaoNumero: versao.numero, canal: versao.canal,
        arquivo: versao.arquivo, distribuicaoLiberada: true, paginaDoArquivo: null,
        origem: 'escolhido', exigidoPor: [], fixado: Boolean(pedido.versaoId),
        incompativeis: [], opcionais: [],
      };
    } catch (erro) {
      erros.push({ fonte: pedido.fonte, projetoId: pedido.projetoId, mensagem: erro.message, codigo: erro.codigo ?? null });
    }
  }));
  return { recursos: porPosicao.filter(Boolean), faltando, erros };
}

/**
 * @param {{loader:string, mc:string, itens:Array<{fonte:string,projetoId:string,versaoId?:string,tipo?:string}>}} entrada
 */
export async function resolver({ loader, mc, loaderVersao = null, itens, contexto = [] }) {
  const alvo = { loader, mc, loaderVersao };
  const resolvidos = new Map(); // chave canônica -> registro
  for (const r of contexto) resolvidos.set(r.chave, { ...r, origem: 'original', fixado: true, exigidoPor: [] });
  const apelidos = new Map(); // chave pedida (slug) -> chave canônica
  const faltando = [];
  const erros = [];
  const avisosCatalogo = [];

  // Shaders seguem outro caminho: não têm dependências nem fabric.mod.json.
  const pedidosDeShader = itens.filter((i) => i.tipo === 'shader');
  const pedidosDeRecurso = itens.filter((i) => i.tipo === 'resourcepack');
  const pedidosDeMod = itens.filter((i) => !['shader', 'resourcepack'].includes(i.tipo));

  const resolucaoShaders = await resolverShaders(pedidosDeShader, alvo);
  const shaders = resolucaoShaders.shaders;
  faltando.push(...resolucaoShaders.faltando);
  erros.push(...resolucaoShaders.erros);
  const resolucaoRecursos = await resolverRecursos(pedidosDeRecurso, alvo);
  const recursos = resolucaoRecursos.recursos;
  faltando.push(...resolucaoRecursos.faltando);
  erros.push(...resolucaoRecursos.erros);

  let fila = pedidosDeMod.map((i) => ({
    fonte: i.fonte,
    projetoId: String(i.projetoId),
    versaoId: i.versaoId ?? null,
    origem: 'escolhido',
    exigidoPor: [],
    profundidade: 0,
  }));

  // Shader sem carregador não liga. O carregador entra na fila como qualquer
  // dependência, e daí em diante passa pelo mesmo ajuste de compatibilidade
  // que os mods (o Iris exige uma faixa do Sodium, por exemplo).
  let carregador = null;
  if (shaders.length) {
    carregador = await carregadorDeShader(alvo);
    if (carregador) {
      fila.push({
        fonte: 'modrinth',
        projetoId: carregador.projetoId,
        versaoId: null,
        origem: 'dependencia',
        exigidoPor: shaders.map((s) => s.chave),
        profundidade: 1,
      });
    }
  }

  while (fila.length) {
    const rodada = agruparPedidos(fila);
    fila = [];

    // Mods da mesma rodada não dependem uns dos outros: resolve em paralelo.
    const resultados = await Promise.allSettled(
      rodada.map(async (pedido) => {
        const pedida = chaveDe(pedido.fonte, pedido.projetoId);
        const chave = apelidos.get(pedida) ?? pedida;
        const existente = resolvidos.get(chave);

        if (existente) {
          // Já resolvido. Só registra quem mais passou a precisar dele.
          for (const nome of pedido.exigidoPor) {
            if (!existente.exigidoPor.includes(nome)) existente.exigidoPor.push(nome);
          }
          if (pedido.origem === 'escolhido') existente.origem = 'escolhido';
          return null;
        }

        const versao = await obterVersao(pedido.fonte, pedido.projetoId, pedido.versaoId, alvo);
        if (!versao) {
          if (pedido.origem === 'dependencia') {
            avisosCatalogo.push(`Dependência cadastrada ${pedido.fonte}:${pedido.projetoId} sem versão na loja; conferindo os arquivos do pack.`);
            return null;
          }
          faltando.push({
            fonte: pedido.fonte,
            projetoId: pedido.projetoId,
            exigidoPor: pedido.exigidoPor,
            motivo: `Nenhuma versão para ${loader} ${mc}.`,
          });
          return null;
        }

        // A busca pode ter vindo por slug ("sodium"), mas a resposta traz o id
        // canônico ("AANobbMI"). Guardamos sempre pelo canônico e anotamos o
        // apelido, senão o mesmo mod entraria duas vezes no pack.
        const projetoCanonico = String(versao.projetoId ?? pedido.projetoId);
        const chaveCanonica = chaveDe(pedido.fonte, projetoCanonico);
        if (chaveCanonica !== pedida) apelidos.set(pedida, chaveCanonica);

        const jaResolvido = resolvidos.get(chaveCanonica);
        if (jaResolvido) {
          for (const nome of pedido.exigidoPor) {
            if (!jaResolvido.exigidoPor.includes(nome)) jaResolvido.exigidoPor.push(nome);
          }
          if (pedido.origem === 'escolhido') jaResolvido.origem = 'escolhido';
          return null;
        }

        const registro = {
          chave: chaveCanonica,
          fonte: pedido.fonte,
          projetoId: projetoCanonico,
          versaoId: versao.id,
          versaoNumero: versao.numero,
          canal: versao.canal,
          arquivo: versao.arquivo,
          distribuicaoLiberada: versao.distribuicaoLiberada !== false && Boolean(versao.arquivo?.url),
          paginaDoArquivo: versao.paginaDoArquivo ?? null,
          origem: pedido.origem,
          exigidoPor: [...pedido.exigidoPor],
          fixado: Boolean(pedido.versaoId),
          incompativeis: versao.dependencias
            .filter((d) => d.tipo === 'incompatible')
            .map((d) => ({ fonte: d.fonte, projetoId: String(d.projetoId) })),
          opcionais: versao.dependencias
            .filter((d) => d.tipo === 'optional')
            .map((d) => ({ fonte: d.fonte, projetoId: String(d.projetoId), versaoId: d.versaoId })),
        };
        resolvidos.set(chaveCanonica, registro);

        return versao.dependencias
          .filter((d) => d.tipo === 'required' && d.projetoId)
          .map((d) => ({
            fonte: d.fonte,
            projetoId: String(d.projetoId),
            versaoId: d.versaoId ?? null,
            origem: 'dependencia',
            exigidoPorChave: chave,
            profundidade: pedido.profundidade + 1,
          }));
      }),
    );

    for (let i = 0; i < resultados.length; i++) {
      const r = resultados[i];
      if (r.status === 'rejected') {
        if (rodada[i].origem === 'dependencia') {
          avisosCatalogo.push(`Cadastro de dependência ${rodada[i].fonte}:${rodada[i].projetoId} indisponível; conferindo as declarações dos JARs.`);
          continue;
        }
        erros.push({
          fonte: rodada[i].fonte,
          projetoId: rodada[i].projetoId,
          mensagem: r.reason?.message ?? String(r.reason),
          codigo: r.reason?.codigo ?? null,
        });
        continue;
      }
      for (const dep of r.value ?? []) {
        if (dep.profundidade > PROFUNDIDADE_MAXIMA) continue;
        fila.push({ ...dep, exigidoPor: [dep.exigidoPorChave] });
      }
    }
  }

  // Nomes e ícones: uma chamada em lote por loja, em vez de uma por mod.
  const porFonte = { modrinth: [], curseforge: [] };
  for (const r of resolvidos.values()) porFonte[r.fonte]?.push(r.projetoId);
  for (const f of faltando) porFonte[f.fonte]?.push(f.projetoId);
  for (const s of shaders) porFonte.modrinth.push(s.projetoId);
  for (const r of recursos) porFonte.modrinth.push(r.projetoId);

  const metadados = new Map();
  await Promise.all(
    Object.entries(porFonte).map(async ([fonte, ids]) => {
      if (!ids.length) return;
      try {
        const projetos = await PROVIDERS[fonte].projetosEmLote(ids);
        for (const p of projetos) metadados.set(chaveDe(fonte, p.id), p);
      } catch (erro) {
        erros.push({ fonte, projetoId: null, mensagem: erro.message, codigo: erro.codigo ?? null });
      }
    }),
  );

  const enriquecer = (registro) => {
    if (registro.origem === 'original') return registro;
    const meta = metadados.get(registro.chave ?? chaveDe(registro.fonte, registro.projetoId));
    return {
      ...registro,
      nome: meta?.nome ?? registro.projetoId,
      slug: meta?.slug ?? null,
      icone: meta?.icone ?? null,
      pagina: meta?.pagina ?? null,
      resumo: meta?.resumo ?? '',
      ladoCliente: meta?.ladoCliente ?? 'unknown',
      ladoServidor: meta?.ladoServidor ?? 'unknown',
    };
  };

  const arquivos = [...resolvidos.values()].map(enriquecer).map((r) => ({
    ...r,
    // Troca as chaves internas por nomes legíveis em "exigido por". A chave
    // guardada pode ser a do slug pedido, então passa pelo apelido antes.
    exigidoPor: r.exigidoPor
      .map((c) => {
        const canonica = apelidos.get(c) ?? c;
        return metadados.get(canonica)?.nome ?? resolvidos.get(canonica)?.nome ?? null;
      })
      .filter(Boolean),
  }));

  await Promise.all(arquivos.map(async (r) => {
    if (r.meta === undefined) r.meta = await lerMetadados(r.arquivo?.url, r.arquivo?.tamanho, loader);
  }));
  // Uma dependencia de outra loja pode ser o mesmo mod ja instalado. Reutiliza
  // o arquivo original/escolhido; duas escolhas explicitas continuam bloqueadas.
  const ordenados = [...arquivos].sort((a, b) => ({ original: 0, escolhido: 1, dependencia: 2 }[a.origem] - { original: 0, escolhido: 1, dependencia: 2 }[b.origem]));
  const semDuplicatasAutomaticas = [];
  for (const r of ordenados) {
    const presente = semDuplicatasAutomaticas.find((a) => mesmoMod(r, a));
    if (presente && r.origem === 'dependencia') {
      presente.exigidoPor = [...new Set([...presente.exigidoPor, ...r.exigidoPor])];
    } else semDuplicatasAutomaticas.push(r);
  }

  // Até aqui o pack é "a versão mais nova de cada mod", que é exatamente o que
  // o Fabric costuma recusar. Agora lemos as exigências de dentro dos jars e
  // mexemos no pack até ele fechar.
  const ajuste = await ajustar({
    registros: semDuplicatasAutomaticas,
    alvo,
    listarVersoes: (fonte, projetoId) =>
      PROVIDERS[fonte]?.versoes(projetoId, alvo).catch(() => []) ?? [],
    acharPorModId: (modid) => acharPorModId(modid, alvo),
  });

  const finais = ajuste.registros;

  // Conflitos: compara cada mod contra os anteriores, uma vez por par.
  const conflitos = [...avisosCatalogo.map((motivo) => ({ severidade: 'aviso', grupo: 'catalogo-indisponivel', titulo: 'Cadastro indisponível na loja', motivo, envolvidos: [] })),
    ...ajuste.verificacao.avisos.map((p) => ({ severidade: 'aviso', grupo: p.tipo, titulo: 'Verificação incompleta', motivo: p.texto, envolvidos: [{ chave: p.chave, nome: p.nome }] }))];
  for (let i = 0; i < finais.length; i++) {
    const candidato = { ...finais[i], id: finais[i].projetoId };
    const anteriores = finais.slice(0, i);
    for (const choque of checarCandidato(candidato, anteriores)) {
      conflitos.push({
        severidade: choque.severidade,
        grupo: choque.grupo,
        titulo: choque.titulo,
        motivo: choque.motivo,
        envolvidos: [
          { chave: finais[i].chave, nome: finais[i].nome },
          { chave: choque.outro.chave, nome: choque.outro.nome },
        ],
      });
    }
  }

  // O que o jar declarou e não tem conserto automático também é bloqueio: é
  // exatamente o erro que apareceria ao abrir o jogo.
  for (const p of ajuste.problemas) {
    conflitos.push({
      severidade: 'bloqueio',
      grupo: p.tipo,
      titulo: ({
        'dependencia-ausente': 'Dependência ausente nos arquivos',
        'dependencia-nao-encontrada': 'Dependência não encontrada',
        'duplicado': 'O mesmo mod está duas vezes no pack',
        'arquivo-duplicado': 'Dois mods usam o mesmo arquivo',
        'versao-incompativel': 'Faixas de versão incompatíveis',
        'sem-versao-possivel': 'Não existe versão que sirva',
        'ambiente-incompativel': 'Minecraft ou loader incompatível',
        'loader-incorreto': 'Mod para outro loader',
        'lado-incorreto': 'Mod para outro ambiente',
        'java-incompativel': 'Exigências de Java incompatíveis',
        'nao-convergiu': 'Ajuste incompleto',
      })[p.tipo] ?? 'Incompatíveis segundo o autor',
      motivo: p.texto,
      envolvidos: [
        { chave: p.chave ?? null, nome: p.nome ?? p.modid },
        ...(p.chaveOutro ? [{ chave: p.chaveOutro, nome: p.comQuem?.[0] }] : []),
      ].filter((e) => e.nome),
    });
  }

  // Shaders escolhidos sem nenhum carregador possível: é um bloqueio, com os
  // nomes. Deixar passar entregaria um shader que nunca liga.
  if (shaders.length && !carregador) {
    const nomeLoader = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[loader] ?? loader;
    conflitos.push({
      severidade: 'bloqueio',
      grupo: 'sem-carregador-de-shader',
      titulo: 'Nenhum carregador de shader',
      motivo:
        `Shaders precisam do Iris ou do Oculus, e nenhum dos dois existe para ${nomeLoader} ${mc}. ` +
        'Tire os shaders ou troque a versão.',
      envolvidos: shaders.map(enriquecer).map((s) => ({ chave: s.chave, nome: s.nome })),
    });
  }

  const manuais = finais.filter((a) => !a.distribuicaoLiberada);

  // A exportação do servidor reutiliza os descritores lidos pelo resolver.
  // A API sempre resolve novamente a seleção; não confia em metadados enviados
  // pelo navegador.
  const mods = finais.filter((r) => r.origem !== 'original').map(({ meta, ...resto }) => ({
    ...resto,
    tipo: 'mod',
    modId: meta?.modId ?? null,
    versaoDeclarada: meta?.versao ?? null,
    fornece: meta?.fornece ?? [],
    dependeDe: Object.keys(meta?.depende ?? {}),
    metadados: meta,
    ambiente: meta?.ambiente ?? null,
  }));

  const shadersProntos = shaders.map(enriquecer).map((s) => ({
    ...s,
    tipo: 'shader',
    modId: null,
    versaoDeclarada: null,
    fornece: [],
    dependeDe: [],
  }));

  const recursosProntos = recursos.map(enriquecer).map((r) => ({
    ...r, tipo: 'resourcepack', modId: null, versaoDeclarada: null,
    fornece: [], dependeDe: [],
  }));

  const arquivosFinais = [...mods, ...shadersProntos, ...recursosProntos];
  const automaticos = arquivosFinais.filter((a) => a.distribuicaoLiberada);

  return {
    alvo,
    arquivos: arquivosFinais,
    // Quem carrega os shaders, e o arquivo de config onde o shader ativo é
    // gravado. A exportação usa para deixar o shader ligado na primeira vez.
    carregadorShader: shaders.length && carregador ? { id: carregador.id, nome: carregador.nome, config: carregador.config } : null,
    conflitos,
    faltando: faltando.map(enriquecer),
    erros,
    manuais: manuais.map(({ meta, ...resto }) => resto),
    trocas: ajuste.trocas,
    adicionadosPorMetadados: ajuste.adicionados,
    verificacao: ajuste.verificacao,
    resumo: {
      total: arquivosFinais.length,
      mods: mods.length,
      shaders: shadersProntos.length,
      recursos: recursosProntos.length,
      escolhidos: arquivosFinais.filter((a) => a.origem === 'escolhido').length,
      dependencias: arquivosFinais.filter((a) => a.origem === 'dependencia').length,
      bloqueios: conflitos.filter((c) => c.severidade === 'bloqueio').length,
      avisos: conflitos.filter((c) => c.severidade === 'aviso').length,
      manuais: manuais.length,
      trocas: ajuste.trocas.length,
      tamanho: automaticos.reduce((s, a) => s + (a.arquivo?.tamanho ?? 0), 0),
    },
  };
}
