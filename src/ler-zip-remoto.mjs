import { inflateRawSync } from 'node:zlib';
import { USER_AGENT } from './http.mjs';

const LIMITE_DIRETORIO = 32 * 1024 * 1024;
const LIMITE_INDICE = 2 * 1024 * 1024;

async function pedirTrecho(url, range, limite) {
  const resposta = await fetch(url, {
    headers: { Range: range, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (resposta.status === 200) {
    const tamanho = Number(resposta.headers.get('content-length'));
    if (!Number.isFinite(tamanho) || tamanho > limite) {
      await resposta.body?.cancel();
      throw new Error('O servidor do .mrpack não permite leitura por partes.');
    }
    const dados = Buffer.from(await resposta.arrayBuffer());
    return { dados, inicio: 0, total: dados.length };
  }
  const faixa = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(resposta.headers.get('content-range') ?? '');
  if (resposta.status !== 206 || !faixa) throw new Error(`Não consegui ler o índice do .mrpack (HTTP ${resposta.status}).`);
  const [, primeiro, ultimo, tamanho] = faixa.map(Number);
  if (ultimo - primeiro + 1 > limite) {
    await resposta.body?.cancel();
    throw new Error('O índice do .mrpack é grande demais.');
  }
  const dados = Buffer.from(await resposta.arrayBuffer());
  if (dados.length !== ultimo - primeiro + 1) throw new Error('Resposta parcial do .mrpack incompleta.');
  return { dados, inicio: primeiro, total: tamanho };
}

function lerEntradasCentrais(dados, quantidade, offsetCentral) {
  const entradas = new Map();
  let pos = 0;
  for (let i = 0; i < quantidade; i++) {
    if (pos + 46 > dados.length || dados.readUInt32LE(pos) !== 0x02014b50) throw new Error('Diretório ZIP inválido.');
    const nomeLen = dados.readUInt16LE(pos + 28);
    const extraLen = dados.readUInt16LE(pos + 30);
    const comentarioLen = dados.readUInt16LE(pos + 32);
    const fim = pos + 46 + nomeLen + extraLen + comentarioLen;
    if (fim > dados.length) throw new Error('Diretório ZIP truncado.');
    const nome = dados.toString('utf8', pos + 46, pos + 46 + nomeLen);
    const local = dados.readUInt32LE(pos + 42);
    if (entradas.has(nome) || local >= offsetCentral) throw new Error('Entradas ZIP inválidas.');
    entradas.set(nome, {
      metodo: dados.readUInt16LE(pos + 10),
      tamanho: dados.readUInt32LE(pos + 20),
      descomprimido: dados.readUInt32LE(pos + 24),
      local,
    });
    pos = fim;
  }
  if (pos !== dados.length) throw new Error('Diretório ZIP contém dados extras.');
  return entradas;
}

/** Lê apenas o diretório do ZIP, sem baixar os overrides do modpack. */
export async function lerDiretorioZipRemoto(url) {
  const fim = await pedirTrecho(url, 'bytes=-65557', LIMITE_DIRETORIO);
  let eocd = -1;
  for (let i = fim.dados.length - 22; i >= 0; i--) {
    if (fim.dados.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + fim.dados.readUInt16LE(i + 20) === fim.dados.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('O .mrpack não é um ZIP válido.');
  const quantidade = fim.dados.readUInt16LE(eocd + 10);
  const tamanhoCentral = fim.dados.readUInt32LE(eocd + 12);
  const offsetCentral = fim.dados.readUInt32LE(eocd + 16);
  if (quantidade === 0xffff || tamanhoCentral === 0xffffffff || offsetCentral === 0xffffffff) {
    throw new Error('Este .mrpack usa ZIP64, que ainda não é suportado.');
  }
  if (!quantidade || quantidade > 20000 || tamanhoCentral > LIMITE_DIRETORIO ||
      offsetCentral + tamanhoCentral > fim.total) throw new Error('Diretório ZIP inválido ou grande demais.');
  const central = offsetCentral >= fim.inicio && offsetCentral + tamanhoCentral <= fim.inicio + fim.dados.length
    ? fim.dados.subarray(offsetCentral - fim.inicio, offsetCentral - fim.inicio + tamanhoCentral)
    : (await pedirTrecho(url, `bytes=${offsetCentral}-${offsetCentral + tamanhoCentral - 1}`, LIMITE_DIRETORIO)).dados;
  return lerEntradasCentrais(central, quantidade, offsetCentral);
}

/** Lê somente um arquivo do ZIP remoto, usado para modrinth.index.json. */
export async function lerArquivoZipRemoto(url, entrada, limite = LIMITE_INDICE) {
  if (!entrada || entrada.descomprimido > limite || entrada.tamanho > limite || ![0, 8].includes(entrada.metodo)) {
    throw new Error('Índice do .mrpack inválido ou grande demais.');
  }
  const cabecalho = (await pedirTrecho(url, `bytes=${entrada.local}-${entrada.local + 29}`, 30)).dados;
  if (cabecalho.length !== 30 || cabecalho.readUInt32LE(0) !== 0x04034b50) throw new Error('Entrada ZIP truncada.');
  const inicio = entrada.local + 30 + cabecalho.readUInt16LE(26) + cabecalho.readUInt16LE(28);
  const comprimido = (await pedirTrecho(url, `bytes=${inicio}-${inicio + entrada.tamanho - 1}`, limite)).dados;
  if (comprimido.length !== entrada.tamanho) throw new Error('Índice ZIP incompleto.');
  const dados = entrada.metodo === 8 ? inflateRawSync(comprimido, { maxOutputLength: limite }) : comprimido;
  if (dados.length !== entrada.descomprimido) throw new Error('Tamanho do índice ZIP incorreto.');
  return dados;
}
