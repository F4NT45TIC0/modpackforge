// Lê as exigências declaradas dentro do .jar sem baixar o .jar inteiro.
//
// Por que isso existe: a API da Modrinth lista dependências como "projeto X",
// sem faixa de versão, e só quando o autor se lembrou de preencher. A verdade
// mora no fabric.mod.json (ou mods.toml) dentro do jar, que traz tanto as
// faixas quanto as dependências que ninguém cadastrou.
//
// Baixar 50 jars para ler um arquivinho de texto seria absurdo. Um ZIP guarda
// o índice no fim, então dá para pedir por HTTP Range só o fim do arquivo,
// achar a entrada e pedir só os bytes dela. Dá ~4% do jar.

import { inflateRawSync } from 'node:zlib';
import { USER_AGENT } from './http.mjs';
import { buscarArquivoPublico } from './arquivo-publico.mjs';

const CAMINHOS = [
  { nome: 'fabric.mod.json', tipo: 'fabric' },
  { nome: 'quilt.mod.json', tipo: 'quilt' },
  { nome: 'META-INF/neoforge.mods.toml', tipo: 'neoforge' },
  { nome: 'META-INF/mods.toml', tipo: 'forge' },
];

const cache = new Map(); // url -> metadados (ou null quando não deu para ler)

async function pedirPedaco(url, de, ate, transporte = fetch) {
  const resposta = await transporte(url, {
    headers: { 'User-Agent': USER_AGENT, Range: `bytes=${de}-${ate}` },
    signal: AbortSignal.timeout(25000),
  });
  if (resposta.status !== 206 && resposta.status !== 200) {
    throw new Error(`Range recusado (HTTP ${resposta.status})`);
  }
  // Alguns CDNs ignoram Range. Nesse caso os offsets continuam absolutos.
  if (resposta.status === 200 && Number(resposta.headers.get('content-length')) > 64 * 1024 * 1024) {
    await resposta.body?.cancel();
    throw new Error('JAR sem suporte a Range e grande demais');
  }
  const partes = []; let total = 0;
  for await (const parte of resposta.body) {
    total += parte.length;
    if (total > 64 * 1024 * 1024) throw new Error('Resposta JAR grande demais');
    partes.push(parte);
  }
  const buf = Buffer.concat(partes);
  if (resposta.status === 200) return buf.subarray(de, ate + 1);
  const faixa = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(resposta.headers.get('content-range') ?? '');
  if (!faixa || Number(faixa[1]) !== de || buf.length !== Number(faixa[2]) - de + 1) throw new Error('Range JAR inválido');
  return buf;
}

function acharEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  return -1;
}

/** Lê o índice central e devolve um mapa nome -> posição da entrada. */
function lerDiretorioCentral(cd, quantidade) {
  const entradas = new Map();
  let p = 0;
  for (let i = 0; i < quantidade && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = cd.readUInt16LE(p + 10);
    const tamanhoComprimido = cd.readUInt32LE(p + 20);
    const nomeLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const comentarioLen = cd.readUInt16LE(p + 32);
    const deslocamentoLocal = cd.readUInt32LE(p + 42);
    const nome = cd.toString('utf8', p + 46, p + 46 + nomeLen);
    entradas.set(nome, { metodo, tamanhoComprimido, deslocamentoLocal, nomeLen, descomprimido: cd.readUInt32LE(p + 24) });
    p += 46 + nomeLen + extraLen + comentarioLen;
  }
  return entradas;
}

/** Mesma extração, mas de um ZIP que já está inteiro na memória. */
function extrairDeBuffer(buf, entrada) {
  if (entrada.descomprimido > 32 * 1024 * 1024) throw new Error('Entrada JAR grande demais');
  const de = entrada.deslocamentoLocal;
  if (buf.readUInt32LE(de) !== 0x04034b50) throw new Error('cabeçalho local inválido');
  const nomeLen = buf.readUInt16LE(de + 26);
  const extraLen = buf.readUInt16LE(de + 28);
  const inicio = de + 30 + nomeLen + extraLen;
  const dados = buf.subarray(inicio, inicio + entrada.tamanhoComprimido);
  if (entrada.metodo === 0) return dados;
  if (entrada.metodo === 8) return inflateRawSync(dados, { maxOutputLength: 32 * 1024 * 1024 });
  throw new Error(`compressão ${entrada.metodo} não suportada`);
}

/** Índice de um ZIP que está todo na memória (caso dos jars aninhados). */
function abrirZipEmMemoria(buf) {
  const eocd = acharEocd(buf);
  if (eocd < 0) throw new Error('fim do índice não encontrado');
  const quantidade = buf.readUInt16LE(eocd + 10);
  const tamanhoCd = buf.readUInt32LE(eocd + 12);
  const deslocamentoCd = buf.readUInt32LE(eocd + 16);
  return lerDiretorioCentral(buf.subarray(deslocamentoCd, deslocamentoCd + tamanhoCd), quantidade);
}

async function extrairArquivo(url, entrada, transporte) {
  if (entrada.descomprimido > 32 * 1024 * 1024 || entrada.tamanhoComprimido > 32 * 1024 * 1024) throw new Error('Entrada JAR grande demais');
  const de = entrada.deslocamentoLocal;
  const bruto = await pedirPedaco(url, de, de + 29, transporte);
  if (bruto.readUInt32LE(0) !== 0x04034b50) throw new Error('cabeçalho local inválido');
  const nomeLen = bruto.readUInt16LE(26);
  const extraLen = bruto.readUInt16LE(28);
  const inicio = de + 30 + nomeLen + extraLen;
  const dados = await pedirPedaco(url, inicio, inicio + entrada.tamanhoComprimido - 1, transporte);

  if (entrada.metodo === 0) return dados;
  if (entrada.metodo === 8) return inflateRawSync(dados, { maxOutputLength: 32 * 1024 * 1024 });
  throw new Error(`compressão ${entrada.metodo} não suportada`);
}

/**
 * Escapa quebras de linha e tabs que aparecem cruas dentro de uma string.
 * Isso é JSON inválido, mas acontece de verdade — a descrição do Better End,
 * por exemplo, tem uma quebra literal no meio do texto.
 */
function escaparControles(texto) {
  let saida = '';
  let dentroDeString = false;
  let escapado = false;
  for (const caractere of texto) {
    if (escapado) {
      saida += caractere;
      escapado = false;
      continue;
    }
    if (caractere === '\\') {
      saida += caractere;
      escapado = true;
      continue;
    }
    if (caractere === '"') {
      dentroDeString = !dentroDeString;
      saida += caractere;
      continue;
    }
    const codigo = caractere.charCodeAt(0);
    if (dentroDeString && codigo < 0x20) {
      saida += codigo === 10 ? '\\n' : codigo === 13 ? '\\r' : codigo === 9 ? '\\t' : '';
      continue;
    }
    saida += caractere;
  }
  return saida;
}

/** JSON de mod às vezes vem com comentário, vírgula sobrando ou controle cru. */
function jsonTolerante(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    const limpo = escaparControles(
      texto
        .replace(/^\uFEFF/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1'),
    ).replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(limpo);
  }
}

// ---------------------------------------------------------------- Fabric

function normalizarExigenciasFabric(bloco) {
  const saida = {};
  for (const [modid, faixa] of Object.entries(bloco ?? {})) saida[modid] = faixa;
  return saida;
}

function lerFabric(texto) {
  const j = jsonTolerante(texto);
  const provides = Array.isArray(j.provides) ? j.provides : [];
  return {
    dialeto: 'fabric',
    tipo: 'fabric',
    ambiente: j.environment ?? '*',
    modId: j.id ?? null,
    versao: typeof j.version === 'string' ? j.version : null,
    fornece: provides,
    // Caminhos dos jars que este mod carrega embutidos. Quem está aí dentro
    // também conta como instalado.
    aninhados: (Array.isArray(j.jars) ? j.jars : []).map((x) => x?.file).filter(Boolean),
    depende: normalizarExigenciasFabric(j.depends),
    recomenda: normalizarExigenciasFabric(j.recommends),
    // "breaks" impede o jogo de abrir; "conflicts" é só um aviso do loader.
    quebra: normalizarExigenciasFabric(j.breaks),
    conflita: normalizarExigenciasFabric(j.conflicts),
  };
}

function lerQuilt(texto) {
  const j = jsonTolerante(texto);
  const q = j.quilt_loader ?? {};
  const exigencias = (lista) => Object.fromEntries((lista ?? []).filter((d) => d && !Array.isArray(d) && d.id && !d.optional && !d.unless && (d.versions == null || typeof d.versions === 'string' || Array.isArray(d.versions)))
    .map((d) => [d.id, d.versions ?? '*']));
  return {
    tipo: 'quilt', dialeto: 'fabric', modId: q.id ?? null, versao: q.version ?? null,
    ambiente: j.minecraft?.environment ?? '*',
    fornece: (q.provides ?? []).map((p) => typeof p === 'string' ? p : p.id).filter(Boolean),
    versaoDe: Object.fromEntries((q.provides ?? []).filter((p) => p.id).map((p) => [p.id, p.version ?? q.version])),
    aninhados: (q.jars ?? []).map((p) => typeof p === 'string' ? p : p.file).filter(Boolean),
    depende: exigencias(q.depends), quebra: exigencias(q.breaks), recomenda: {}, conflita: {},
    incompleto: (q.depends ?? []).some((d) => Array.isArray(d) || d?.unless || (d?.versions && typeof d.versions === 'object' && !Array.isArray(d.versions))),
  };
}

// -------------------------------------------------------- Forge / NeoForge

/**
 * Leitor mínimo de mods.toml. Só precisamos de [[mods]] e [[dependencies.*]],
 * então não vale arrastar um parser de TOML completo.
 */
function lerModsToml(texto) {
  const mods = [];
  const dependencias = [];
  const features = [];
  let secao = null;
  let atual = null;
  let multiline = null;

  const desaspar = (v) => {
    const t = v.trim();
    if (/^"""/.test(t)) return t.replace(/^"""|"""$/g, '');
    if (/^["']/.test(t)) return t.slice(1, -1);
    return t;
  };

  for (const linhaBruta of texto.split(/\r?\n/)) {
    if (multiline) {
      if (linhaBruta.includes(multiline)) multiline = null;
      continue;
    }
    const linha = linhaBruta.replace(/(^|\s)#.*$/, '').trim();
    if (!linha) continue;

    const tabela = linha.match(/^\[\[?([^\]]+)\]\]?$/);
    if (tabela) {
      const caminho = tabela[1].trim();
      atual = {};
      if (caminho === 'mods') {
        secao = 'mods';
        mods.push(atual);
      } else if (caminho.startsWith('dependencies.')) {
        secao = 'dependencias';
        atual.__de = caminho.slice('dependencies.'.length).replace(/^["']|["']$/g, '');
        dependencias.push(atual);
      } else if (caminho.startsWith('features.')) {
        secao = 'features';
        features.push(atual);
      } else {
        secao = null;
        atual = null;
      }
      continue;
    }

    const par = linha.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
    if (par && atual && secao) {
      const [, chave, valor] = par;
      const t = valor.trim();
      const delimitador = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
      if (delimitador && !t.slice(3).includes(delimitador)) { multiline = delimitador; continue; }
      atual[chave] = t === 'true' ? true : t === 'false' ? false : desaspar(t);
    }
  }
  return { mods, dependencias, features };
}

function lerForge(texto, tipo) {
  const { mods, dependencias, features } = lerModsToml(texto);
  const principal = mods[0] ?? {};
  const modId = principal.modId ?? null;

  const depende = {};
  const dependeServidor = {};
  const dependeCliente = {};
  const quebra = {};
  const quebraServidor = {};
  const quebraCliente = {};
  for (const d of dependencias) {
    const alvo = d.modId;
    if (!alvo) continue;
    const faixa = d.versionRange ?? '*';
    const obrigatoria = d.type ? d.type === 'required' : d.mandatory !== false;
    const paraCliente = d.side !== 'SERVER';
    const paraServidor = d.side !== 'CLIENT';
    if (d.type === 'incompatible') {
      quebra[alvo] = faixa;
      if (paraCliente) quebraCliente[alvo] = faixa;
      if (paraServidor) quebraServidor[alvo] = faixa;
    } else if (obrigatoria) {
      depende[alvo] = faixa;
      if (paraCliente) dependeCliente[alvo] = faixa;
      if (paraServidor) dependeServidor[alvo] = faixa;
    }
  }

  return {
    dialeto: 'maven',
    tipo,
    ambiente: 'unknown',
    modId,
    versao: typeof principal.version === 'string' ? principal.version : null,
    fornece: mods.slice(1).map((m) => m.modId).filter(Boolean),
    idsPrincipais: mods.map((m) => m.modId).filter(Boolean),
    versaoDe: Object.fromEntries(mods.map((m) => [m.modId, m.version])),
    depende,
    dependeServidor, dependeCliente, quebraServidor, quebraCliente,
    regrasDependencia: dependencias.filter((d) => d.modId && !['incompatible', 'discouraged'].includes(d.type)).map((d) => ({
      id: d.modId, faixa: d.versionRange ?? '*', lado: d.side ?? 'BOTH',
      obrigatoria: d.type ? d.type === 'required' : d.mandatory !== false,
    })),
    exigenciasJava: features.map((f) => f.javaVersion).filter(Boolean),
    recomenda: {},
    quebra,
    conflita: {},
  };
}


/** Seleciona o descritor do loader que vai carregar o arquivo. */
async function montarMeta(entradas, extrair, loader, profundidade = 0, orcamento = { bytes: 0, jars: 0 }) {
  const aceitos = loader === 'quilt' ? ['quilt', 'fabric'] : loader === 'neoforge' ? ['neoforge', 'forge'] : loader ? [loader] : CAMINHOS.map((c) => c.tipo);
  const caminho = aceitos.flatMap((tipo) => CAMINHOS.filter((c) => c.tipo === tipo)).find((c) => entradas.has(c.nome));
  if (!caminho) return null;
  const texto = (await extrair(entradas.get(caminho.nome))).toString('utf8');
  const meta = caminho.tipo === 'fabric' ? lerFabric(texto) : caminho.tipo === 'quilt' ? lerQuilt(texto) : lerForge(texto, loader === 'neoforge' ? 'neoforge' : caminho.tipo);
  if (!meta.modId) return null;
  meta.idsPrincipais ??= [meta.modId];
  meta.versaoDe ??= {};
  if (meta.versao?.includes('${')) {
    const manifest = entradas.get('META-INF/MANIFEST.MF');
    const versao = manifest && (await extrair(manifest)).toString('utf8').match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim();
    meta.versao = versao || null;
  }
  meta.versaoDe[meta.modId] = meta.versao;
  for (const id of meta.fornece) {
    if (meta.versaoDe[id]?.includes?.('${')) meta.versaoDe[id] = meta.versao;
    meta.versaoDe[id] ??= meta.versao;
  }
  // Jar-in-jar do Forge/NeoForge tambem fornece mod IDs.
  const jarjar = entradas.get('META-INF/jarjar/metadata.json');
  if (jarjar) {
    try {
      const j = JSON.parse((await extrair(jarjar)).toString('utf8'));
      meta.aninhados = (j.jars ?? []).map((j) => j.path).filter(Boolean);
    } catch { meta.incompleto = true; }
  }
  meta.embutidos = [];
  meta.forneceDeclarados = [...meta.fornece];
  for (const caminhoInterno of meta.aninhados ?? []) {
    try {
      const entrada = entradas.get(caminhoInterno);
      if (!entrada || profundidade >= 4 || ++orcamento.jars > 256) throw new Error('Limite de jars aninhados');
      orcamento.bytes += entrada.descomprimido;
      if (orcamento.bytes > 96 * 1024 * 1024) throw new Error('Limite de leitura aninhada');
      const buf = await extrair(entrada);
      const dentro = await montarMeta(abrirZipEmMemoria(buf), (e) => extrairDeBuffer(buf, e), loader, profundidade + 1, orcamento);
      if (!dentro) continue; // biblioteca Java comum, sem descriptor de mod
      meta.embutidos.push(dentro);
      meta.incompleto ||= dentro.incompleto;
      for (const id of [dentro.modId, ...dentro.fornece]) {
        if (!meta.fornece.includes(id)) meta.fornece.push(id);
        meta.versaoDe[id] = dentro.versaoDe[id] ?? dentro.versao;
      }
    } catch { meta.incompleto = true; }
  }
  return meta;
}

export async function lerMetadadosBuffer(buf, loader = null) {
  try { return await montarMeta(abrirZipEmMemoria(buf), (e) => extrairDeBuffer(buf, e), loader); }
  catch { return null; }
}

// Compartilhamos promessas e limitamos o numero de jars remotos simultaneos.
let ativos = 0;
const espera = [];
async function limitado(fn) {
  if (ativos >= 8) await new Promise((ok) => espera.push(ok));
  else ativos++;
  try { return await fn(); }
  finally { const proximo = espera.shift(); if (proximo) proximo(); else ativos--; }
}

export async function lerMetadados(url, tamanhoConhecido = 0, loader = null, { publico = false } = {}) {
  if (!url) return null;
  const transporte = publico ? buscarArquivoPublico : fetch;
  const chave = `${publico}:${loader ?? '*'}:${url}`;
  if (cache.has(chave)) return cache.get(chave);
  const pedido = limitado(async () => {
    try {
      let tamanho = tamanhoConhecido;
      if (!tamanho) {
        const head = await transporte(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(25000) });
        tamanho = Number(head.headers.get('content-length')) || 0;
        if (!tamanho) throw new Error('tamanho desconhecido');
      }
      const inicioRabo = Math.max(0, tamanho - 65557);
      const rabo = await pedirPedaco(url, inicioRabo, tamanho - 1, transporte);
      const eocd = acharEocd(rabo);
      if (eocd < 0) throw new Error('ZIP invalido');
      const quantidade = rabo.readUInt16LE(eocd + 10);
      const tamanhoCd = rabo.readUInt32LE(eocd + 12);
      const deslocamentoCd = rabo.readUInt32LE(eocd + 16);
      if (quantidade === 0xffff || tamanhoCd > 8 * 1024 * 1024 || deslocamentoCd === 0xffffffff) throw new Error('ZIP64 ou indice grande demais');
      const cd = deslocamentoCd >= inicioRabo
        ? rabo.subarray(deslocamentoCd - inicioRabo, deslocamentoCd - inicioRabo + tamanhoCd)
        : await pedirPedaco(url, deslocamentoCd, deslocamentoCd + tamanhoCd - 1, transporte);
      return await montarMeta(lerDiretorioCentral(cd, quantidade), (e) => extrairArquivo(url, e, transporte), loader);
    } catch { return null; }
  });
  cache.set(chave, pedido);
  const meta = await pedido;
  // Falhas de rede podem ser temporarias: permita tentar de novo.
  if (!meta) cache.delete(chave);
  if (cache.size > 2500) cache.delete(cache.keys().next().value);
  return meta;
}

export const MODS_DO_AMBIENTE = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base',
  'forge', 'neoforge', 'mcp', 'fml',
]);
