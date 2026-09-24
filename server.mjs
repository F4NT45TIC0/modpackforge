// ModpackForge — servidor local.
// Serve a interface e faz o papel de intermediário com a Modrinth e a CurseForge:
// as chaves e o cache ficam aqui, o navegador só desenha.

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as modrinth from './src/modrinth.mjs';
import * as curseforge from './src/curseforge.mjs';
import { LOADERS, versoesDoJogo, versoesDoLoader, versaoSugerida, loaderValido } from './src/loaders.mjs';
import { resolver } from './src/resolver.mjs';
import { gerarBat, gerarMrpack, gerarListaTexto, gerarSlug } from './src/exportar.mjs';
import { gerarInstaladorServidor, gerarAjudaWindows, separarPorLado } from './src/exportar-servidor.mjs';
import { lerConfig, gravarConfig, caminhoDaConfig } from './src/store.mjs';
import { limparCache } from './src/http.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/**
 * Carimbo do código que este processo carregou.
 *
 * O Node carrega cada módulo uma vez por processo: editar um arquivo não muda o
 * servidor que já está no ar. Deixar um processo antigo rodando enquanto se
 * acredita estar usando o código novo é um erro caro e silencioso — este
 * carimbo aparece no arranque e na API para que dê para conferir.
 */
async function carimboDoCodigo() {
  const { readdir, stat } = await import('node:fs/promises');
  const arquivos = [
    path.join(AQUI, 'server.mjs'),
    ...(await readdir(path.join(AQUI, 'src')))
      .filter((n) => n.endsWith('.mjs'))
      .map((n) => path.join(AQUI, 'src', n)),
  ];
  let maisNovo = 0;
  for (const arquivo of arquivos) {
    const info = await stat(arquivo).catch(() => null);
    if (info && info.mtimeMs > maisNovo) maisNovo = info.mtimeMs;
  }
  return { codigoDe: new Date(maisNovo).toISOString(), processoDesde: new Date().toISOString() };
}

let CARIMBO = { codigoDe: null, processoDesde: new Date().toISOString() };
const PASTA_WEB = path.join(AQUI, 'web');
const PASTA_PACKS = path.join(AQUI, 'packs');
const PORTA_INICIAL = Number(process.env.PORTA) || 7477;

// ----------------------------------------------------------------- utilidades

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function responderJson(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store',
  });
  res.end(corpo);
}

async function lerCorpo(req, limite = 2 * 1024 * 1024) {
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > limite) throw Object.assign(new Error('Corpo grande demais'), { status: 413 });
    partes.push(parte);
  }
  if (!partes.length) return {};
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

/** Valida na fronteira: nada entra nos providers sem passar por aqui. */
function validarAlvo(params) {
  const loader = String(params.loader ?? '');
  const mc = String(params.mc ?? '');
  if (!loaderValido(loader)) throw Object.assign(new Error('Modloader inválido'), { status: 400 });
  if (!/^[\w.\-+]{1,32}$/.test(mc)) throw Object.assign(new Error('Versão do Minecraft inválida'), { status: 400 });
  return { loader, mc };
}

function validarItens(itens) {
  if (!Array.isArray(itens)) throw Object.assign(new Error('Lista de mods ausente'), { status: 400 });
  if (itens.length > 400) throw Object.assign(new Error('Limite de 400 mods por pack'), { status: 400 });
  return itens.map((i) => {
    if (!['modrinth', 'curseforge'].includes(i.fonte)) {
      throw Object.assign(new Error('Fonte inválida'), { status: 400 });
    }
    if (!/^[\w-]{1,32}$/.test(String(i.projetoId ?? ''))) {
      throw Object.assign(new Error('Id de projeto inválido'), { status: 400 });
    }
    return { fonte: i.fonte, projetoId: String(i.projetoId), versaoId: i.versaoId ? String(i.versaoId) : null };
  });
}

// -------------------------------------------------------------------- rotas

const rotas = {
  'GET /api/inicio': async () => {
    const [versoes, config, chaveCf] = await Promise.all([
      versoesDoJogo(),
      lerConfig(),
      curseforge.temChave(),
    ]);
    return {
      loaders: LOADERS,
      versoesDoJogo: versoes,
      categorias: modrinth.CATEGORIAS,
      curseforgeAtiva: chaveCf,
      carimbo: CARIMBO,
      preferencias: {
        ultimoLoader: config.ultimoLoader,
        ultimaVersaoJogo: config.ultimaVersaoJogo,
      },
      pastaDePacks: PASTA_PACKS,
    };
  },

  'GET /api/loader-versoes': async ({ params }) => {
    const { loader, mc } = validarAlvo(params);
    const lista = await versoesDoLoader(loader, mc);
    return { versoes: lista, sugerida: versaoSugerida(lista) };
  },

  'GET /api/buscar': async ({ params }) => {
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

    const [rm, rc] = await Promise.allSettled([
      params.fontes === 'curseforge' ? Promise.resolve({ total: 0, itens: [] }) : modrinth.buscar(pedido),
      querCurseforge ? curseforge.buscar(pedido) : Promise.resolve({ total: 0, itens: [] }),
    ]);

    const avisos = [];
    const semResultado = { total: 0, itens: [] };

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

  'GET /api/projeto': async ({ params }) => {
    const { loader, mc } = validarAlvo(params);
    const [item] = validarItens([{ fonte: params.fonte, projetoId: params.id }]);
    const provider = item.fonte === 'modrinth' ? modrinth : curseforge;
    const [projeto, versoes] = await Promise.all([
      provider.projeto(item.projetoId),
      provider.versoes(item.projetoId, { loader, mc }),
    ]);
    return { projeto, versoes };
  },

  'POST /api/resolver': async ({ corpo }) => {
    const { loader, mc } = validarAlvo(corpo);
    const itens = validarItens(corpo.itens ?? []);
    if (!itens.length) {
      return { alvo: { loader, mc }, arquivos: [], conflitos: [], faltando: [], erros: [], manuais: [], resumo: { total: 0, escolhidos: 0, dependencias: 0, bloqueios: 0, avisos: 0, manuais: 0, tamanho: 0 } };
    }
    return resolver({ loader, mc, itens });
  },

  'POST /api/exportar': async ({ corpo }) => {
    const { loader, mc } = validarAlvo(corpo);
    const itens = validarItens(corpo.itens ?? []);
    if (!itens.length) throw Object.assign(new Error('O pack está vazio'), { status: 400 });

    const nome = String(corpo.nome ?? '').trim().slice(0, 80) || 'Meu pack';
    const loaderVersao = String(corpo.loaderVersao ?? '').slice(0, 40);
    if (!loaderVersao) throw Object.assign(new Error('Escolha a versão do modloader'), { status: 400 });

    const formatos = Array.isArray(corpo.formatos) && corpo.formatos.length ? corpo.formatos : ['bat'];
    const opcoes = {
      nome,
      autor: String(corpo.autor ?? '').slice(0, 60),
      memoriaMb: Math.max(2048, Math.min(16384, Number(corpo.memoriaMb) || 4096)),
      versaoDoPack: String(corpo.versaoDoPack ?? '1.0.0').slice(0, 20),
      loaderVersao,
    };

    const plano = await resolver({ loader, mc, itens });

    const destino = path.join(PASTA_PACKS, gerarSlug(nome));
    await mkdir(destino, { recursive: true });

    const gerados = [];
    if (formatos.includes('bat')) {
      const bat = await gerarBat(plano, opcoes);
      await writeFile(path.join(destino, bat.nomeArquivo), bat.conteudo);
      gerados.push({ tipo: 'bat', arquivo: bat.nomeArquivo, tamanho: bat.conteudo.length });
    }
    if (formatos.includes('mrpack')) {
      const mrpack = await gerarMrpack(plano, opcoes);
      await writeFile(path.join(destino, mrpack.nomeArquivo), mrpack.conteudo);
      gerados.push({ tipo: 'mrpack', arquivo: mrpack.nomeArquivo, tamanho: mrpack.conteudo.length });
    }
    if (formatos.includes('txt')) {
      const lista = gerarListaTexto(plano, opcoes);
      await writeFile(path.join(destino, lista.nomeArquivo), lista.conteudo);
      gerados.push({ tipo: 'txt', arquivo: lista.nomeArquivo, tamanho: lista.conteudo.length });
    }

    let servidor = null;
    if (formatos.includes('servidor')) {
      const sh = await gerarInstaladorServidor(plano, { ...opcoes, porta: Number(corpo.porta) || 25565 });
      // Fim de linha Unix preservado: o arquivo vai rodar numa VPS Linux.
      await writeFile(path.join(destino, sh.nomeArquivo), sh.conteudo);
      gerados.push({ tipo: 'servidor', arquivo: sh.nomeArquivo, tamanho: sh.conteudo.length });

      const ajuda = await gerarAjudaWindows(plano, opcoes);
      await writeFile(path.join(destino, ajuda.nomeArquivo), ajuda.conteudo);
      gerados.push({ tipo: 'servidor-lista', arquivo: ajuda.nomeArquivo, tamanho: ajuda.conteudo.length });

      servidor = { mods: sh.contagem, somenteCliente: sh.somenteCliente, manuais: sh.manuais };
    }

    await gravarConfig({ ultimoLoader: loader, ultimaVersaoJogo: mc });

    return {
      pasta: destino,
      gerados,
      resumo: plano.resumo,
      servidor,
      manuais: plano.manuais.map((m) => ({ nome: m.nome, pagina: m.paginaDoArquivo ?? m.pagina })),
    };
  },

  'GET /api/config': async () => {
    const config = await lerConfig();
    return {
      // Nunca devolvemos a chave inteira para a interface.
      curseforgeAtiva: Boolean(config.chaveCurseforge) && !curseforge.chaveFoiReprovada(),
      curseforgeReprovada: curseforge.chaveFoiReprovada(),
      curseforgeFinal: config.chaveCurseforge ? `...${config.chaveCurseforge.slice(-6)}` : null,
      caminhoDaConfig,
      pastaDePacks: PASTA_PACKS,
    };
  },

  'POST /api/config/curseforge': async ({ corpo }) => {
    const chave = String(corpo.chave ?? '').trim();
    if (!chave) {
      await gravarConfig({ chaveCurseforge: '' });
      curseforge.esquecerReprovacao();
      limparCache();
      return { curseforgeAtiva: false };
    }
    await curseforge.validarChave(chave);
    await gravarConfig({ chaveCurseforge: chave });
    limparCache();
    return { curseforgeAtiva: true, curseforgeFinal: `...${chave.slice(-6)}` };
  },

  'POST /api/abrir-pasta': async ({ corpo }) => {
    const alvo = path.resolve(String(corpo.pasta ?? PASTA_PACKS));
    // Só abrimos pastas dentro da área do app.
    if (!alvo.startsWith(PASTA_PACKS)) throw Object.assign(new Error('Pasta fora do app'), { status: 400 });
    spawn('explorer.exe', [alvo], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
};

// ------------------------------------------------------------------ estáticos

async function servirEstatico(req, res, caminhoUrl) {
  // As regras de conflito são um módulo sem dependências, então o navegador
  // importa exatamente o mesmo arquivo que o resolver usa aqui. Uma regra só,
  // nos dois lados — a interface bloqueia na hora e o servidor confere de novo.
  if (caminhoUrl === '/compartilhado/conflitos.mjs') {
    const dados = await readFile(path.join(AQUI, 'src', 'conflitos.mjs'));
    res.writeHead(200, { 'Content-Type': TIPOS['.js'], 'Content-Length': dados.length });
    res.end(dados);
    return;
  }

  const relativo = caminhoUrl === '/' ? 'index.html' : decodeURIComponent(caminhoUrl).replace(/^\/+/, '');
  const completo = path.join(PASTA_WEB, relativo);
  if (!completo.startsWith(PASTA_WEB)) {
    res.writeHead(403).end('Proibido');
    return;
  }
  try {
    const dados = await readFile(completo);
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(completo)] ?? 'application/octet-stream',
      'Content-Length': dados.length,
      'Cache-Control': 'no-cache',
    });
    res.end(dados);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
  }
}

// -------------------------------------------------------------------- servidor

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Só aceitamos chamadas da própria máquina.
  const origem = req.headers.origin;
  if (origem && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origem)) {
    responderJson(res, 403, { erro: 'Origem não permitida' });
    return;
  }

  const chave = `${req.method} ${url.pathname}`;
  const rota = rotas[chave];

  if (!rota) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      await servirEstatico(req, res, url.pathname);
    } else {
      responderJson(res, 404, { erro: 'Rota não encontrada' });
    }
    return;
  }

  try {
    const params = Object.fromEntries(url.searchParams);
    const corpo = req.method === 'POST' ? await lerCorpo(req) : {};
    responderJson(res, 200, await rota({ params, corpo, req }));
  } catch (erro) {
    const status = erro.status ?? (erro.codigo === 'CF_SEM_CHAVE' ? 428 : 502);
    if (!erro.status && !erro.codigo) console.error(`[${chave}]`, erro.message);
    responderJson(res, status, { erro: erro.message, codigo: erro.codigo ?? null });
  }
});

function ouvir(porta, tentativasRestantes = 10) {
  servidor.once('error', (erro) => {
    if (erro.code === 'EADDRINUSE' && tentativasRestantes > 0) {
      ouvir(porta + 1, tentativasRestantes - 1);
    } else {
      console.error('Não consegui abrir o servidor:', erro.message);
      process.exit(1);
    }
  });
  servidor.listen(porta, '127.0.0.1', async () => {
    const endereco = `http://localhost:${porta}`;
    await mkdir(PASTA_PACKS, { recursive: true });
    CARIMBO = await carimboDoCodigo();
    console.log('');
    if (porta !== PORTA_INICIAL) {
      console.log(`  ATENÇÃO: a porta ${PORTA_INICIAL} já estava ocupada.`);
      console.log('  Outro ModpackForge está rodando. Feche o antigo, senão o navegador');
      console.log('  pode continuar falando com ele e usando código velho.');
      console.log('');
    }
    console.log('  ModpackForge rodando em ' + endereco);
    console.log('  Código de ' + CARIMBO.codigoDe);
    console.log('  Os packs gerados vão para ' + PASTA_PACKS);
    console.log('  Feche esta janela para encerrar.');
    console.log('');
    if (!process.env.SEM_NAVEGADOR) {
      spawn('cmd', ['/c', 'start', '""', endereco], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}

ouvir(PORTA_INICIAL);
