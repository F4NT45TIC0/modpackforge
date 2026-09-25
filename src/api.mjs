// Rotas da API, escritas contra Request e Response do padrão web.
//
// O mesmo código atende dois lugares:
//   - o servidor local (server.mjs converte o http do Node para Request);
//   - a função da Vercel (api/index.js exporta este tratador direto).
// Um caminho só: o que é testado no PC é o que roda no site.
//
// O que muda entre os dois modos é só o que depende de ter um disco e um dono:
// no PC os packs são gravados em packs/ e a chave da CurseForge é salva pela
// tela de Configurações; no site os arquivos voltam como download e a chave é
// definida por quem hospeda.

import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as modrinth from './modrinth.mjs';
import * as curseforge from './curseforge.mjs';
import { LOADERS, versoesDoJogo, versoesDoLoader, versaoSugerida, loaderValido } from './loaders.mjs';
import { resolver } from './resolver.mjs';
import { gerarBat, gerarMrpack, gerarListaTexto, gerarSlug } from './exportar.mjs';
import { gerarInstaladorServidor, gerarAjudaWindows } from './exportar-servidor.mjs';
import { lerConfig, gravarConfig, caminhoDaConfig } from './store.mjs';
import { limparCache } from './http.mjs';
import { lerModpackPublicado, prepararModpackPublicado } from './modpack-publicado.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_PACKS = path.join(RAIZ, 'packs');

// Onde este código está rodando NÃO é adivinhado por variável de ambiente.
//
// Quem chama o tratador diz: api/index.js (a função da Vercel) sempre passa
// { nuvem: true }, e o server.mjs do PC passa false. Antes a decisão vinha da
// variável VERCEL, que a Vercel só expõe se uma opção do projeto estiver ligada.
// Com ela desligada o código se achava no PC, exigia Host localhost e o site
// inteiro respondia 403. O ponto de entrada sabe onde está; a configuração do
// projeto, não necessariamente.

// Num site público cada pack custa minutos de função e centenas de chamadas às
// lojas. O limite menor protege a conta de quem hospeda de um abuso barato.
const limiteDeMods = (nuvem) => (nuvem ? 150 : 400);
const LIMITE_CORPO = 2 * 1024 * 1024;

/** Identifica o código que está respondendo. O servidor local preenche no arranque. */
export const carimbo = {
  codigoDe: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  processoDesde: new Date().toISOString(),
};

const falha = (status, mensagem) => Object.assign(new Error(mensagem), { status });

// --------------------------------------------------------------- validação

/** Valida na fronteira: nada entra nos providers sem passar por aqui. */
function validarAlvo(params) {
  const loader = String(params.loader ?? '');
  const mc = String(params.mc ?? '');
  if (!loaderValido(loader)) throw falha(400, 'Modloader inválido');
  if (!/^[\w.\-+]{1,32}$/.test(mc)) throw falha(400, 'Versão do Minecraft inválida');
  return { loader, mc };
}

function validarItens(itens, nuvem) {
  const limite = limiteDeMods(nuvem);
  if (!Array.isArray(itens)) throw falha(400, 'Lista de mods ausente');
  if (itens.length > limite) throw falha(400, `Limite de ${limite} mods por pack`);
  return itens.map((i) => {
    if (!['modrinth', 'curseforge'].includes(i?.fonte)) throw falha(400, 'Fonte inválida');
    if (!/^[\w-]{1,32}$/.test(String(i.projetoId ?? ''))) throw falha(400, 'Id de projeto inválido');
    const tipo = i.tipo ?? 'mod';
    if (!['mod', 'shader', 'resourcepack'].includes(tipo)) throw falha(400, 'Tipo de arquivo inválido');
    if (tipo !== 'mod' && i.fonte !== 'modrinth') throw falha(400, 'Tipo disponível somente na Modrinth');
    return {
      fonte: i.fonte,
      projetoId: String(i.projetoId),
      versaoId: i.versaoId ? String(i.versaoId).slice(0, 40) : null,
      tipo,
    };
  });
}

const RESUMO_VAZIO = { total: 0, escolhidos: 0, dependencias: 0, bloqueios: 0, avisos: 0, manuais: 0, tamanho: 0 };

function validarIdsModpack(projetoId, versaoId) {
  if (!/^[\w-]{1,32}$/.test(String(projetoId ?? '')) || !/^[\w-]{1,40}$/.test(String(versaoId ?? ''))) {
    throw falha(400, 'Modpack ou versão inválida');
  }
}

function arquivoDoPlano(a) {
  const tipo = a.tipo === 'shader' ? 'shaderpacks' : a.tipo === 'resourcepack' ? 'resourcepacks' : 'mods';
  return {
    path: `${tipo}/${a.arquivo.nome}`,
    hashes: { sha1: a.arquivo.sha1, ...(a.arquivo.sha512 ? { sha512: a.arquivo.sha512 } : {}) },
    env: { client: 'required', server: tipo !== 'mods' || a.ladoServidor === 'unsupported' ? 'unsupported' : 'required' },
    downloads: [a.arquivo.url],
    fileSize: a.arquivo.tamanho ?? 0,
    projetoId: a.fonte === 'modrinth' ? a.projetoId : null,
    versaoId: a.fonte === 'modrinth' ? a.versaoId : null,
  };
}

// ------------------------------------------------------------------- rotas

const rotas = {
  'GET inicio': async ({ nuvem }) => {
    const [versoes, config, chaveCf] = await Promise.all([
      versoesDoJogo(),
      lerConfig(),
      curseforge.temChave(),
    ]);
    return {
      modo: nuvem ? 'nuvem' : 'local',
      loaders: LOADERS,
      versoesDoJogo: versoes,
      categorias: modrinth.CATEGORIAS,
      categoriasPorTipo: {
        mod: modrinth.CATEGORIAS,
        shader: modrinth.CATEGORIAS_SHADER,
        modpack: modrinth.CATEGORIAS_MODPACK,
        resourcepack: modrinth.CATEGORIAS_RECURSO,
      },
      curseforgeAtiva: chaveCf,
      carimbo,
      preferencias: {
        ultimoLoader: config.ultimoLoader,
        ultimaVersaoJogo: config.ultimaVersaoJogo,
      },
      pastaDePacks: nuvem ? null : PASTA_PACKS,
    };
  },

  'GET loader-versoes': async ({ params }) => {
    const { loader, mc } = validarAlvo(params);
    const lista = await versoesDoLoader(loader, mc);
    return { versoes: lista, sugerida: versaoSugerida(lista) };
  },

  'GET buscar': async ({ params }) => {
    const { loader, mc } = validarAlvo(params);
    const tipo = ['mod', 'shader', 'modpack', 'resourcepack'].includes(params.tipo) ? params.tipo : 'mod';
    const consulta = String(params.q ?? '').slice(0, 120);
    const ordem = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(params.ordem)
      ? params.ordem
      : 'relevance';
    const categorias = String(params.categorias ?? '').split(',').filter(Boolean).slice(0, 4);
    const pagina = Math.max(0, Math.min(50, Number(params.pagina) || 0));
    const limite = 20;
    const deslocamento = pagina * limite;

    const querCurseforge = tipo === 'mod' && params.fontes !== 'modrinth' && (await curseforge.temChave());
    const pedido = { consulta, loader, mc, categorias, ordem, deslocamento, limite, tipo };
    const semResultado = { total: 0, itens: [] };

    const [rm, rc] = await Promise.allSettled([
      tipo === 'mod' && params.fontes === 'curseforge' ? Promise.resolve(semResultado) : modrinth.buscar(pedido),
      querCurseforge ? curseforge.buscar(pedido) : Promise.resolve(semResultado),
    ]);

    const avisos = [];
    let daModrinth = semResultado;
    if (rm.status === 'fulfilled') daModrinth = rm.value;
    else avisos.push({ texto: `Modrinth: ${rm.reason.message}`, codigo: rm.reason.codigo ?? null });

    let daCurseforge = semResultado;
    if (rc.status === 'fulfilled') daCurseforge = rc.value;
    else avisos.push({ texto: `CurseForge: ${rc.reason.message}`, codigo: rc.reason.codigo ?? null });

    // A busca pulou a CurseForge por causa de uma chave recusada antes: avisa,
    // senão os mods de lá somem da lista sem explicação nenhuma.
    if (tipo === 'mod' && !querCurseforge && curseforge.chaveFoiReprovada()) {
      avisos.push({
        texto: 'A CurseForge está fora da busca: a chave de API foi recusada.',
        codigo: 'CF_CHAVE_INVALIDA',
      });
    }

    // Intercala as duas listas para nenhuma loja dominar o topo.
    const itens = [];
    for (let i = 0; i < Math.max(daModrinth.itens.length, daCurseforge.itens.length); i++) {
      if (daModrinth.itens[i]) itens.push(daModrinth.itens[i]);
      if (daCurseforge.itens[i]) itens.push(daCurseforge.itens[i]);
    }

    return {
      itens,
      total: daModrinth.total + daCurseforge.total,
      temMais: daModrinth.itens.length === limite || daCurseforge.itens.length === limite,
      avisos,
    };
  },

  'GET projeto': async ({ params, nuvem }) => {
    const { loader, mc } = validarAlvo(params);
    const tipo = ['mod', 'shader', 'modpack', 'resourcepack'].includes(params.tipo) ? params.tipo : 'mod';
    if (tipo === 'modpack' && params.fonte !== 'modrinth') throw falha(400, 'Modpacks publicados vêm da Modrinth');
    const [item] = validarItens([{ fonte: params.fonte, projetoId: params.id, tipo: tipo === 'modpack' ? 'mod' : tipo }], nuvem);
    const provider = item.fonte === 'modrinth' ? modrinth : curseforge;
    const [projeto, versoes] = await Promise.all([
      provider.projeto(item.projetoId),
      tipo === 'shader' ? modrinth.versoesShader(item.projetoId)
        : tipo === 'resourcepack' ? modrinth.versoesRecurso(item.projetoId, mc)
          : tipo === 'modpack' ? modrinth.versoes(item.projetoId, { loader, mc })
            : provider.versoes(item.projetoId, { loader, mc }),
    ]);
    if (projeto.tipo !== tipo && !(tipo === 'mod' && !projeto.tipo)) throw falha(400, 'Tipo de projeto não confere');
    return { projeto, versoes };
  },

  'POST baixar-modpack': async ({ corpo, nuvem }) => {
    const projetoId = String(corpo.projetoId ?? '');
    const versaoId = String(corpo.versaoId ?? '');
    validarIdsModpack(projetoId, versaoId);
    const preparado = await prepararModpackPublicado(projetoId, versaoId, {
      memoriaMb: corpo.memoriaMb, porta: corpo.porta,
    });
    let pasta = null;
    if (!nuvem) {
      pasta = path.join(PASTA_PACKS, gerarSlug(preparado.resumo.nome));
      await mkdir(pasta, { recursive: true });
      await writeFile(path.join(pasta, preparado.nomeArquivo), preparado.script);
    }
    return {
      pasta,
      mrpack: { nome: preparado.versao.arquivo.nome, url: preparado.versao.arquivo.url },
      servidor: { nome: preparado.nomeArquivo, base64: preparado.script.toString('base64') },
      resumo: preparado.resumo,
    };
  },

  'GET importar-modpack': async ({ params }) => {
    validarIdsModpack(params.projetoId, params.versaoId);
    const base = await lerModpackPublicado(params.projetoId, params.versaoId);
    const projetos = await modrinth.projetosEmLote(base.arquivos.map((a) => a.projetoId));
    const porId = new Map(projetos.map((p) => [p.id, p]));
    const arquivos = base.arquivos.map((a) => {
      const projeto = porId.get(a.projetoId);
      const tipo = a.caminho.startsWith('shaderpacks/') ? 'shader'
        : a.caminho.startsWith('resourcepacks/') ? 'resourcepack'
          : a.caminho.startsWith('mods/') ? 'mod' : 'arquivo';
      return {
        caminho: a.caminho, nome: projeto?.nome ?? a.caminho.split('/').at(-1), slug: projeto?.slug ?? null,
        projetoId: a.projetoId, versaoId: a.versaoId, tipo, icone: projeto?.icone ?? null,
        tamanho: base.indice.files.find((f) => f.path === a.caminho)?.fileSize ?? 0,
      };
    });
    const configuracoes = [...base.entradas.keys()].filter((nome) =>
      /^(overrides|client-overrides|server-overrides)\//.test(nome) && !nome.endsWith('/'));
    return {
      projeto: { id: base.projeto.id, nome: base.projeto.nome },
      versao: { id: base.versao.id, nome: base.versao.nome, arquivo: base.versao.arquivo },
      alvo: { mc: base.mc, loader: base.loader, loaderVersao: base.loaderVersao },
      arquivos, configuracoes,
    };
  },

  'POST exportar-modpack-editado': async ({ corpo, nuvem }) => {
    validarIdsModpack(corpo.projetoId, corpo.versaoId);
    const removidos = corpo.removidos ?? [];
    if (!Array.isArray(removidos) || removidos.length > 1500 ||
        removidos.some((p) => typeof p !== 'string' || p.length > 240)) throw falha(400, 'Arquivos removidos inválidos');
    const itens = validarItens(corpo.itens ?? [], nuvem);
    const base = await lerModpackPublicado(corpo.projetoId, corpo.versaoId);
    const ativos = base.arquivos.filter((a) => !removidos.includes(a.caminho));
    const porProjeto = new Map(ativos.filter((a) => a.projetoId).map((a) => [a.projetoId, a]));
    if (itens.some((i) => i.fonte === 'modrinth' && porProjeto.has(i.projetoId))) {
      throw falha(409, 'Esse mod já está no modpack original. Remova a versão original antes de adicionar outra.');
    }
    const plano = itens.length ? await resolver({ loader: base.loader, mc: base.mc, itens }) : null;
    if (plano && (plano.resumo.bloqueios || plano.faltando.length || plano.erros.length)) {
      throw falha(409, 'Os mods adicionais têm conflitos ou arquivos sem versão. Resolva antes de gerar.');
    }
    const extras = [];
    for (const a of plano?.arquivos ?? []) {
      const original = a.fonte === 'modrinth' ? porProjeto.get(a.projetoId) : null;
      if (original) {
        if (a.fixado && original.versaoId !== a.versaoId) {
          throw falha(409, `O mod adicional exige outra versão de ${a.nome}. Remova a versão original e adicione a exigida.`);
        }
        continue;
      }
      if (!a.distribuicaoLiberada || !a.arquivo?.url || !a.arquivo?.sha1) {
        throw falha(409, `Não há download automático para ${a.nome}.`);
      }
      extras.push(arquivoDoPlano(a));
    }
    const preparado = await prepararModpackPublicado(corpo.projetoId, corpo.versaoId, {
      base, removidos, acrescidos: extras,
      nome: String(corpo.nome ?? '').trim().slice(0, 80) || `${base.projeto.nome} editado`,
      memoriaMb: corpo.memoriaMb, porta: corpo.porta,
    });
    const revisao = createHash('sha256')
      .update(JSON.stringify({ nome: preparado.indice.name, removidos: [...removidos].sort(), extras }))
      .digest('hex').slice(0, 12);
    preparado.indice.versionId = `modpackforge-${base.versao.id}-${revisao}`;
    return {
      origem: { url: base.versao.arquivo.url, nome: base.versao.arquivo.nome, tamanho: base.versao.arquivo.tamanho },
      indice: preparado.indice,
      servidor: { nome: preparado.nomeArquivo, base64: preparado.script.toString('base64') },
      resumo: preparado.resumo,
      adicionais: extras.length,
    };
  },

  'POST resolver': async ({ corpo, nuvem }) => {
    const { loader, mc } = validarAlvo(corpo);
    const itens = validarItens(corpo.itens ?? [], nuvem);
    if (!itens.length) {
      return { alvo: { loader, mc }, arquivos: [], conflitos: [], faltando: [], erros: [], manuais: [], trocas: [], resumo: RESUMO_VAZIO };
    }
    return resolver({ loader, mc, itens });
  },

  'POST exportar': async ({ corpo, nuvem }) => {
    const { loader, mc } = validarAlvo(corpo);
    const itens = validarItens(corpo.itens ?? [], nuvem);
    if (!itens.length) throw falha(400, 'O pack está vazio');

    const nome = String(corpo.nome ?? '').trim().slice(0, 80) || 'Meu pack';
    const loaderVersao = String(corpo.loaderVersao ?? '').slice(0, 40);
    if (!loaderVersao) throw falha(400, 'Escolha a versão do modloader');

    const formatos = Array.isArray(corpo.formatos) && corpo.formatos.length ? corpo.formatos : ['bat'];
    const opcoes = {
      nome,
      autor: String(corpo.autor ?? '').slice(0, 60),
      memoriaMb: Math.max(2048, Math.min(16384, Number(corpo.memoriaMb) || 4096)),
      versaoDoPack: String(corpo.versaoDoPack ?? '1.0.0').slice(0, 20),
      loaderVersao,
    };

    const plano = await resolver({ loader, mc, itens });
    if (plano.resumo.bloqueios || plano.faltando.length || plano.erros.length) {
      throw falha(409, 'Este pack ainda tem conflitos ou arquivos sem versão. Resolva antes de gerar.');
    }

    const arquivos = [];
    if (formatos.includes('bat')) {
      const bat = await gerarBat(plano, opcoes);
      arquivos.push({ tipo: 'bat', arquivo: bat.nomeArquivo, conteudo: bat.conteudo });
    }
    if (formatos.includes('mrpack')) {
      const mrpack = await gerarMrpack(plano, opcoes);
      arquivos.push({ tipo: 'mrpack', arquivo: mrpack.nomeArquivo, conteudo: mrpack.conteudo });
    }
    if (formatos.includes('txt')) {
      const lista = gerarListaTexto(plano, opcoes);
      arquivos.push({ tipo: 'txt', arquivo: lista.nomeArquivo, conteudo: lista.conteudo });
    }

    let servidor = null;
    if (formatos.includes('servidor')) {
      const porta = Math.max(1, Math.min(65535, Number(corpo.porta) || 25565));
      const sh = await gerarInstaladorServidor(plano, { ...opcoes, porta });
      arquivos.push({ tipo: 'servidor', arquivo: sh.nomeArquivo, conteudo: sh.conteudo });
      const ajuda = await gerarAjudaWindows(plano, opcoes);
      arquivos.push({ tipo: 'servidor-lista', arquivo: ajuda.nomeArquivo, conteudo: ajuda.conteudo });
      servidor = { mods: sh.contagem, somenteCliente: sh.somenteCliente, manuais: sh.manuais };
    }

    // No PC os arquivos também ficam em packs/. No site não há disco onde
    // gravar: eles voltam só na resposta, e a interface oferece o download.
    let pasta = null;
    if (!nuvem) {
      pasta = path.join(PASTA_PACKS, gerarSlug(nome));
      await mkdir(pasta, { recursive: true });
      for (const a of arquivos) await writeFile(path.join(pasta, a.arquivo), a.conteudo);
      await gravarConfig({ ultimoLoader: loader, ultimaVersaoJogo: mc });
    }

    return {
      pasta,
      gerados: arquivos.map((a) => ({
        tipo: a.tipo,
        arquivo: a.arquivo,
        tamanho: a.conteudo.length,
        base64: a.conteudo.toString('base64'),
      })),
      resumo: plano.resumo,
      servidor,
      manuais: plano.manuais.map((m) => ({ nome: m.nome, pagina: m.paginaDoArquivo ?? m.pagina })),
    };
  },

  'GET config': async ({ nuvem }) => ({
    // Nunca devolvemos a chave inteira. No site, nem o final: quem visita não
    // tem por que saber nada sobre a chave de quem hospeda.
    configuravel: !nuvem,
    curseforgeAtiva: (await curseforge.chaveGravada()) && !curseforge.chaveFoiReprovada(),
    curseforgeReprovada: curseforge.chaveFoiReprovada(),
    curseforgeFinal: nuvem ? null : await curseforge.finalDaChave(),
    chaveDoAmbiente: curseforge.chaveVemDoAmbiente(),
    caminhoDaConfig: nuvem ? null : caminhoDaConfig,
    pastaDePacks: nuvem ? null : PASTA_PACKS,
  }),

  'POST config/curseforge': async ({ corpo, nuvem }) => {
    if (nuvem) {
      throw falha(
        403,
        'Neste site a chave da CurseForge é definida por quem hospeda, na variável CURSEFORGE_API_KEY.',
      );
    }
    const chave = String(corpo.chave ?? '').trim();
    if (!chave) {
      await gravarConfig({ chaveCurseforge: '' });
      curseforge.esquecerReprovacao();
      limparCache();
      return { curseforgeAtiva: curseforge.chaveVemDoAmbiente() };
    }
    await curseforge.validarChave(chave);
    await gravarConfig({ chaveCurseforge: chave });
    limparCache();
    return { curseforgeAtiva: true, curseforgeFinal: `...${chave.slice(-6)}` };
  },

  'POST abrir-pasta': async ({ corpo, nuvem }) => {
    if (nuvem) throw falha(404, 'Rota não encontrada');
    const alvo = path.resolve(String(corpo.pasta ?? PASTA_PACKS));
    // Só abrimos pastas dentro da área do app.
    if (alvo !== PASTA_PACKS && !alvo.startsWith(PASTA_PACKS + path.sep)) {
      throw falha(400, 'Pasta fora do app');
    }
    spawn('explorer.exe', [alvo], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
};

// --------------------------------------------------------------- segurança

const EH_LOCAL = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * No PC, só aceitamos chamadas da própria máquina, e conferimos também o Host:
 * sem isso, um site malicioso que redirecione o próprio domínio para 127.0.0.1
 * (DNS rebinding) conseguiria ler as respostas desta API.
 *
 * No site essa checagem não protege nada — não há sessão, cookie nem estado a
 * roubar, e sem cabeçalhos de CORS outro site não lê as respostas. Mantê-la lá
 * só arriscaria recusar o próprio site, caso a Vercel repasse um Host interno.
 */
function chamadaPermitida(request, nuvem) {
  if (nuvem) return true;
  // O cabeçalho Host é o que o navegador mandou; sem ele, vale o host da URL —
  // que o server.mjs monta a partir do mesmo cabeçalho, então dizem a mesma coisa.
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (!EH_LOCAL.test(host)) return false;
  const origem = request.headers.get('origin');
  if (!origem) return true;
  try {
    return EH_LOCAL.test(new URL(origem).host);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- tratador

const responderJson = (status, dados) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/**
 * Nome da rota pedida.
 *
 * Na Vercel todo /api/* é reescrito para a função única com ?rota=<caminho>
 * (ver vercel.json). Se por algum motivo o parâmetro não vier, o caminho
 * original da URL resolve — assim a função funciona nas duas formas.
 */
function nomeDaRota(url) {
  const doParametro = url.searchParams.get('rota');
  const bruto = doParametro ?? url.pathname.replace(/^\/api\/?/, '');
  return decodeURIComponent(bruto).replace(/^\/+|\/+$/g, '');
}

async function lerCorpo(request) {
  if (request.method !== 'POST') return {};
  const declarado = Number(request.headers.get('content-length'));
  if (declarado > LIMITE_CORPO) throw falha(413, 'Corpo grande demais');
  const texto = await request.text();
  if (Buffer.byteLength(texto) > LIMITE_CORPO) throw falha(413, 'Corpo grande demais');
  if (!texto.trim()) return {};
  try {
    return JSON.parse(texto);
  } catch {
    throw falha(400, 'JSON inválido');
  }
}

/**
 * Atende qualquer chamada a /api/*.
 * @param {Request} request
 * @param {{ nuvem?: boolean }} ambiente  quem chama diz onde está rodando
 */
export async function tratarApi(request, { nuvem = false } = {}) {
  if (!chamadaPermitida(request, nuvem)) return responderJson(403, { erro: 'Origem não permitida' });

  const url = new URL(request.url);
  const nome = nomeDaRota(url);
  const rota = rotas[`${request.method} ${nome}`];
  if (!rota) return responderJson(404, { erro: 'Rota não encontrada' });

  try {
    const params = Object.fromEntries(url.searchParams);
    delete params.rota;
    const corpo = await lerCorpo(request);
    return responderJson(200, await rota({ params, corpo, nuvem }));
  } catch (erro) {
    const status = erro.status ?? (erro.codigo === 'CF_SEM_CHAVE' ? 428 : 502);
    if (!erro.status && !erro.codigo) console.error(`[${request.method} ${nome}]`, erro.message);
    return responderJson(status, { erro: erro.message, codigo: erro.codigo ?? null });
  }
}
