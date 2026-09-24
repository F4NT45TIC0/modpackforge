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

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_PACKS = path.join(RAIZ, 'packs');

/** A Vercel define VERCEL=1 em todo ambiente dela. */
export const NA_NUVEM = Boolean(process.env.VERCEL);

// Num site público cada pack custa minutos de função e centenas de chamadas às
// lojas. O limite menor protege a conta de quem hospeda de um abuso barato.
const LIMITE_MODS = NA_NUVEM ? 150 : 400;
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

function validarItens(itens) {
  if (!Array.isArray(itens)) throw falha(400, 'Lista de mods ausente');
  if (itens.length > LIMITE_MODS) throw falha(400, `Limite de ${LIMITE_MODS} mods por pack`);
  return itens.map((i) => {
    if (!['modrinth', 'curseforge'].includes(i?.fonte)) throw falha(400, 'Fonte inválida');
    if (!/^[\w-]{1,32}$/.test(String(i.projetoId ?? ''))) throw falha(400, 'Id de projeto inválido');
    return {
      fonte: i.fonte,
      projetoId: String(i.projetoId),
      versaoId: i.versaoId ? String(i.versaoId).slice(0, 40) : null,
    };
  });
}

const RESUMO_VAZIO = { total: 0, escolhidos: 0, dependencias: 0, bloqueios: 0, avisos: 0, manuais: 0, tamanho: 0 };

// ------------------------------------------------------------------- rotas

const rotas = {
  'GET inicio': async () => {
    const [versoes, config, chaveCf] = await Promise.all([
      versoesDoJogo(),
      lerConfig(),
      curseforge.temChave(),
    ]);
    return {
      modo: NA_NUVEM ? 'nuvem' : 'local',
      loaders: LOADERS,
      versoesDoJogo: versoes,
      categorias: modrinth.CATEGORIAS,
      curseforgeAtiva: chaveCf,
      carimbo,
      preferencias: {
        ultimoLoader: config.ultimoLoader,
        ultimaVersaoJogo: config.ultimaVersaoJogo,
      },
      pastaDePacks: NA_NUVEM ? null : PASTA_PACKS,
    };
  },

  'GET loader-versoes': async ({ params }) => {
    const { loader, mc } = validarAlvo(params);
    const lista = await versoesDoLoader(loader, mc);
    return { versoes: lista, sugerida: versaoSugerida(lista) };
  },

  'GET buscar': async ({ params }) => {
    const { loader, mc } = validarAlvo(params);
    const consulta = String(params.q ?? '').slice(0, 120);
    const ordem = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(params.ordem)
      ? params.ordem
      : 'relevance';
    const categorias = String(params.categorias ?? '').split(',').filter(Boolean).slice(0, 4);
    const pagina = Math.max(0, Math.min(50, Number(params.pagina) || 0));
    const limite = 20;
    const deslocamento = pagina * limite;

    const querCurseforge = params.fontes !== 'modrinth' && (await curseforge.temChave());
    const pedido = { consulta, loader, mc, categorias, ordem, deslocamento, limite };
    const semResultado = { total: 0, itens: [] };

    const [rm, rc] = await Promise.allSettled([
      params.fontes === 'curseforge' ? Promise.resolve(semResultado) : modrinth.buscar(pedido),
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
    if (!querCurseforge && curseforge.chaveFoiReprovada()) {
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

  'GET projeto': async ({ params }) => {
    const { loader, mc } = validarAlvo(params);
    const [item] = validarItens([{ fonte: params.fonte, projetoId: params.id }]);
    const provider = item.fonte === 'modrinth' ? modrinth : curseforge;
    const [projeto, versoes] = await Promise.all([
      provider.projeto(item.projetoId),
      provider.versoes(item.projetoId, { loader, mc }),
    ]);
    return { projeto, versoes };
  },

  'POST resolver': async ({ corpo }) => {
    const { loader, mc } = validarAlvo(corpo);
    const itens = validarItens(corpo.itens ?? []);
    if (!itens.length) {
      return { alvo: { loader, mc }, arquivos: [], conflitos: [], faltando: [], erros: [], manuais: [], trocas: [], resumo: RESUMO_VAZIO };
    }
    return resolver({ loader, mc, itens });
  },

  'POST exportar': async ({ corpo }) => {
    const { loader, mc } = validarAlvo(corpo);
    const itens = validarItens(corpo.itens ?? []);
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
    if (!NA_NUVEM) {
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

  'GET config': async () => ({
    // Nunca devolvemos a chave inteira. No site, nem o final: quem visita não
    // tem por que saber nada sobre a chave de quem hospeda.
    configuravel: !NA_NUVEM,
    curseforgeAtiva: (await curseforge.chaveGravada()) && !curseforge.chaveFoiReprovada(),
    curseforgeReprovada: curseforge.chaveFoiReprovada(),
    curseforgeFinal: NA_NUVEM ? null : await curseforge.finalDaChave(),
    chaveDoAmbiente: curseforge.chaveVemDoAmbiente(),
    caminhoDaConfig: NA_NUVEM ? null : caminhoDaConfig,
    pastaDePacks: NA_NUVEM ? null : PASTA_PACKS,
  }),

  'POST config/curseforge': async ({ corpo }) => {
    if (NA_NUVEM) {
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

  'POST abrir-pasta': async ({ corpo }) => {
    if (NA_NUVEM) throw falha(404, 'Rota não encontrada');
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
function chamadaPermitida(request) {
  if (NA_NUVEM) return true;
  const host = request.headers.get('host') ?? '';
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

/** Atende qualquer chamada a /api/*. */
export async function tratarApi(request) {
  if (!chamadaPermitida(request)) return responderJson(403, { erro: 'Origem não permitida' });

  const url = new URL(request.url);
  const nome = nomeDaRota(url);
  const rota = rotas[`${request.method} ${nome}`];
  if (!rota) return responderJson(404, { erro: 'Rota não encontrada' });

  try {
    const params = Object.fromEntries(url.searchParams);
    delete params.rota;
    const corpo = await lerCorpo(request);
    return responderJson(200, await rota({ params, corpo }));
  } catch (erro) {
    const status = erro.status ?? (erro.codigo === 'CF_SEM_CHAVE' ? 428 : 502);
    if (!erro.status && !erro.codigo) console.error(`[${request.method} ${nome}]`, erro.message);
    return responderJson(status, { erro: erro.message, codigo: erro.codigo ?? null });
  }
}
