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

const CAMINHOS = [
  { nome: 'fabric.mod.json', tipo: 'fabric' },
  { nome: 'quilt.mod.json', tipo: 'quilt' },
  { nome: 'META-INF/neoforge.mods.toml', tipo: 'neoforge' },
  { nome: 'META-INF/mods.toml', tipo: 'forge' },
];

const RABO = 65536;
const cache = new Map(); // url -> metadados (ou null quando não deu para ler)

async function pedirPedaco(url, de, ate) {
  const resposta = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Range: `bytes=${de}-${ate}` },
    signal: AbortSignal.timeout(25000),
  });
  if (resposta.status !== 206 && resposta.status !== 200) {
    throw new Error(`Range recusado (HTTP ${resposta.status})`);
  }
  return Buffer.from(await resposta.arrayBuffer());
}

function acharEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
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
    entradas.set(nome, { metodo, tamanhoComprimido, deslocamentoLocal, nomeLen });
    p += 46 + nomeLen + extraLen + comentarioLen;
  }
  return entradas;
}

/** Mesma extração, mas de um ZIP que já está inteiro na memória. */
function extrairDeBuffer(buf, entrada) {
  const de = entrada.deslocamentoLocal;
  if (buf.readUInt32LE(de) !== 0x04034b50) throw new Error('cabeçalho local inválido');
  const nomeLen = buf.readUInt16LE(de + 26);
  const extraLen = buf.readUInt16LE(de + 28);
  const inicio = de + 30 + nomeLen + extraLen;
  const dados = buf.subarray(inicio, inicio + entrada.tamanhoComprimido);
  if (entrada.metodo === 0) return dados;
  if (entrada.metodo === 8) return inflateRawSync(dados);
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

async function extrairArquivo(url, entrada) {
  // O cabeçalho local repete o nome e pode ter um campo extra de tamanho
  // diferente do índice central, então pegamos uma folga e lemos os tamanhos reais.
  const folga = 30 + entrada.nomeLen + 1024;
  const de = entrada.deslocamentoLocal;
  const bruto = await pedirPedaco(url, de, de + folga + entrada.tamanhoComprimido);

  if (bruto.readUInt32LE(0) !== 0x04034b50) throw new Error('cabeçalho local inválido');
  const nomeLen = bruto.readUInt16LE(26);
  const extraLen = bruto.readUInt16LE(28);
  const inicio = 30 + nomeLen + extraLen;
  const dados = bruto.subarray(inicio, inicio + entrada.tamanhoComprimido);

  if (entrada.metodo === 0) return dados;
  if (entrada.metodo === 8) return inflateRawSync(dados);
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

// -------------------------------------------------------- Forge / NeoForge

/**
 * Leitor mínimo de mods.toml. Só precisamos de [[mods]] e [[dependencies.*]],
 * então não vale arrastar um parser de TOML completo.
 */
function lerModsToml(texto) {
  const mods = [];
  const dependencias = [];
  let secao = null;
  let atual = null;

  const desaspar = (v) => {
    const t = v.trim();
    if (/^"""/.test(t)) return t.replace(/^"""|"""$/g, '');
    if (/^["']/.test(t)) return t.slice(1, -1);
    return t;
  };

  for (const linhaBruta of texto.split(/\r?\n/)) {
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
      atual[chave] = t === 'true' ? true : t === 'false' ? false : desaspar(t);
    }
  }
  return { mods, dependencias };
}

function lerForge(texto, tipo) {
  const { mods, dependencias } = lerModsToml(texto);
  const principal = mods[0] ?? {};
  const modId = principal.modId ?? null;

  const depende = {};
  const quebra = {};
  for (const d of dependencias) {
    if (d.__de && modId && d.__de !== modId) continue; // dependência de outro mod do mesmo jar
    const alvo = d.modId;
    if (!alvo) continue;
    const faixa = d.versionRange ?? '*';
    const obrigatoria = d.type ? d.type === 'required' : d.mandatory !== false;
    if (d.type === 'incompatible') quebra[alvo] = faixa;
    else if (obrigatoria) depende[alvo] = faixa;
  }

  return {
    dialeto: 'maven',
    tipo,
    modId,
    versao: typeof principal.version === 'string' ? principal.version : null,
    fornece: [],
    depende,
    recomenda: {},
    quebra,
    conflita: {},
  };
}

/**
 * Abre os jars embutidos e devolve os modids que eles trazem, cada um com a
 * SUA versão.
 *
 * A versão importa: o Fabric API 0.116 carrega dentro de si o
 * fabric-rendering-fluids-v1 na versão 3.x, e mods pedem faixas do submódulo,
 * não do pacote. Tratar o conteúdo embutido como se tivesse a versão do jar pai
 * faz a comparação comparar coisas diferentes.
 */
async function lerAninhados(url, entradas, caminhos) {
  const encontrados = [];
  const lote = caminhos.slice(0, 24); // bibliotecas grandes embutem muita coisa
  await Promise.all(
    lote.map(async (caminho) => {
      const entrada = entradas.get(caminho);
      if (!entrada) return;
      try {
        const jarInterno = await extrairArquivo(url, entrada);
        const internas = abrirZipEmMemoria(jarInterno);
        const fmj = internas.get('fabric.mod.json') ?? internas.get('quilt.mod.json');
        if (!fmj) return;
        const meta = lerFabric(extrairDeBuffer(jarInterno, fmj).toString('utf8'));
        if (meta.modId) encontrados.push({ id: meta.modId, versao: meta.versao });
        for (const id of meta.fornece ?? []) encontrados.push({ id, versao: meta.versao });
      } catch {
        // um aninhado ilegível não invalida o resto
      }
    }),
  );
  return encontrados;
}

// ------------------------------------------------------------------ público

/**
 * Metadados de um mod a partir da URL do jar.
 * Devolve null quando não dá para ler — nunca lança, porque um jar ilegível
 * não pode derrubar a montagem do pack inteiro.
 */
export async function lerMetadados(url, tamanhoConhecido = 0) {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url);

  try {
    let tamanho = tamanhoConhecido;
    if (!tamanho) {
      const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
      tamanho = Number(head.headers.get('content-length')) || 0;
      if (!tamanho) throw new Error('tamanho desconhecido');
    }

    const inicioRabo = Math.max(0, tamanho - RABO);
    const rabo = await pedirPedaco(url, inicioRabo, tamanho - 1);

    const eocd = acharEocd(rabo);
    if (eocd < 0) throw new Error('fim do índice não encontrado');

    const quantidade = rabo.readUInt16LE(eocd + 10);
    const tamanhoCd = rabo.readUInt32LE(eocd + 12);
    const deslocamentoCd = rabo.readUInt32LE(eocd + 16);
    if (deslocamentoCd === 0xffffffff) throw new Error('ZIP64 não suportado');

    // Jar grande: o índice começa antes do que já baixamos, então pedimos só ele.
    const cd =
      deslocamentoCd >= inicioRabo
        ? rabo.subarray(deslocamentoCd - inicioRabo, deslocamentoCd - inicioRabo + tamanhoCd)
        : await pedirPedaco(url, deslocamentoCd, deslocamentoCd + tamanhoCd - 1);

    const entradas = lerDiretorioCentral(cd, quantidade);

    for (const { nome, tipo } of CAMINHOS) {
      const entrada = entradas.get(nome);
      if (!entrada) continue;
      const texto = (await extrairArquivo(url, entrada)).toString('utf8');
      const meta =
        tipo === 'fabric' || tipo === 'quilt' ? lerFabric(texto) : lerForge(texto, tipo);

      // Mods Fabric costumam embutir as próprias bibliotecas. Sem abrir esses
      // jars aninhados, acusaríamos como faltando algo que já vem junto.
      //
      // `versaoDe` guarda a versão de cada modid que este jar entrega: a dele
      // próprio, a dos que ele declara fornecer, e a de cada jar embutido.
      meta.versaoDe = Object.create(null);
      if (meta.modId) meta.versaoDe[meta.modId] = meta.versao;
      for (const id of meta.fornece) meta.versaoDe[id] = meta.versao;

      if (meta.aninhados?.length) {
        const dentro = await lerAninhados(url, entradas, meta.aninhados);
        for (const { id, versao } of dentro) {
          if (!meta.fornece.includes(id)) meta.fornece.push(id);
          meta.versaoDe[id] = versao ?? meta.versao;
        }
      }

      cache.set(url, meta);
      return meta;
    }

    cache.set(url, null);
    return null;
  } catch {
    // Silencioso de propósito: sem metadados o resolver cai no comportamento
    // anterior, que funciona, só é menos preciso.
    cache.set(url, null);
    return null;
  }
}

/** Ignoramos exigências que o próprio ambiente satisfaz. */
export const MODS_DO_AMBIENTE = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base',
  'forge', 'neoforge', 'mcp', 'fml',
]);
