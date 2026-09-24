// ModpackForge — servidor local.
//
// Serve a interface e repassa as chamadas de /api para src/api.mjs, o mesmo
// tratador que roda como função na Vercel. Este arquivo só cuida do que é do PC:
// arquivos estáticos, porta, e abrir o navegador.

import http from 'node:http';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tratarApi, carimbo, PASTA_PACKS } from './src/api.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PASTA_WEB = path.join(AQUI, 'web');
const PORTA_INICIAL = Number(process.env.PORTA) || 7477;
const LIMITE_CORPO = 2 * 1024 * 1024;

/**
 * Carimbo do código que este processo carregou.
 *
 * O Node carrega cada módulo uma vez por processo: editar um arquivo não muda o
 * servidor que já está no ar. Deixar um processo antigo rodando enquanto se
 * acredita estar usando o código novo é um erro caro e silencioso — este
 * carimbo aparece no arranque e na API para que dê para conferir.
 */
async function dataDoCodigoMaisNovo() {
  const pastas = [AQUI, path.join(AQUI, 'src'), path.join(AQUI, 'web', 'compartilhado')];
  let maisNovo = 0;
  for (const pasta of pastas) {
    for (const nome of await readdir(pasta).catch(() => [])) {
      if (!nome.endsWith('.mjs')) continue;
      const info = await stat(path.join(pasta, nome)).catch(() => null);
      if (info && info.mtimeMs > maisNovo) maisNovo = info.mtimeMs;
    }
  }
  return new Date(maisNovo).toISOString();
}

// ------------------------------------------------------------------ estáticos

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // O navegador recusa um módulo servido sem tipo de JavaScript.
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

async function servirEstatico(res, caminhoUrl) {
  let relativo;
  try {
    relativo = caminhoUrl === '/' ? 'index.html' : decodeURIComponent(caminhoUrl).replace(/^\/+/, '');
  } catch {
    res.writeHead(400).end('Caminho inválido');
    return;
  }
  const completo = path.join(PASTA_WEB, relativo);
  if (completo !== PASTA_WEB && !completo.startsWith(PASTA_WEB + path.sep)) {
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

// --------------------------------------------------------- ponte para a API

async function lerBruto(req) {
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > LIMITE_CORPO) return null;
    partes.push(parte);
  }
  return Buffer.concat(partes);
}

/** Converte a requisição do Node em Request, chama a API e devolve a Response. */
async function repassarParaApi(req, res) {
  const corpo = req.method === 'GET' || req.method === 'HEAD' ? undefined : await lerBruto(req);
  if (corpo === null) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'Corpo grande demais' }));
    return;
  }

  const cabecalhos = new Headers();
  for (const [nome, valor] of Object.entries(req.headers)) {
    if (valor !== undefined) cabecalhos.set(nome, Array.isArray(valor) ? valor.join(', ') : valor);
  }

  const pedido = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers: cabecalhos,
    body: corpo,
  });

  const resposta = await tratarApi(pedido);
  const dados = Buffer.from(await resposta.arrayBuffer());
  res.writeHead(resposta.status, {
    ...Object.fromEntries(resposta.headers),
    'Content-Length': dados.length,
  });
  res.end(dados);
}

// -------------------------------------------------------------------- servidor

const servidor = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await repassarParaApi(req, res);
    } else if (req.method === 'GET') {
      await servirEstatico(res, pathname);
    } else {
      res.writeHead(405).end('Método não permitido');
    }
  } catch (erro) {
    console.error(`[${req.method} ${pathname}]`, erro.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Erro interno');
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
    carimbo.codigoDe = await dataDoCodigoMaisNovo();
    carimbo.processoDesde = new Date().toISOString();

    console.log('');
    if (porta !== PORTA_INICIAL) {
      console.log(`  ATENÇÃO: a porta ${PORTA_INICIAL} já estava ocupada.`);
      console.log('  Outro ModpackForge está rodando. Feche o antigo, senão o navegador');
      console.log('  pode continuar falando com ele e usando código velho.');
      console.log('');
    }
    console.log('  ModpackForge rodando em ' + endereco);
    console.log('  Código de ' + carimbo.codigoDe);
    console.log('  Os packs gerados vão para ' + PASTA_PACKS);
    console.log('  Feche esta janela para encerrar.');
    console.log('');
    if (!process.env.SEM_NAVEGADOR) {
      spawn('cmd', ['/c', 'start', '""', endereco], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}

ouvir(PORTA_INICIAL);
