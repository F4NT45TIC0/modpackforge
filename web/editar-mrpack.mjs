// Reempacota um .mrpack grande no navegador. Copia as entradas originais como
// bytes ZIP, sem descompactar overrides: configs e arquivos do autor ficam iguais.

const texto = new TextEncoder();
const td = new TextDecoder();
const LIMITE_DIRETORIO = 32 * 1024 * 1024;

const u16 = (v, p) => v.getUint16(p, true);
const u32 = (v, p) => v.getUint32(p, true);
const w16 = (v, p, n) => v.setUint16(p, n, true);
const w32 = (v, p, n) => v.setUint32(p, n, true);

const tabelaCrc = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = tabelaCrc[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function lerDiretorio(blob) {
  const inicioCauda = Math.max(0, blob.size - 65557);
  const cauda = new Uint8Array(await blob.slice(inicioCauda).arrayBuffer());
  const v = new DataView(cauda.buffer);
  let fim = -1;
  for (let i = cauda.length - 22; i >= 0; i--) {
    if (u32(v, i) === 0x06054b50 && i + 22 + u16(v, i + 20) === cauda.length) {
      fim = i;
      break;
    }
  }
  if (fim < 0) throw new Error('O .mrpack original não é um ZIP válido.');
  const quantidade = u16(v, fim + 10);
  const tamanho = u32(v, fim + 12);
  const offset = u32(v, fim + 16);
  if (!quantidade || quantidade > 20000 || tamanho > LIMITE_DIRETORIO ||
      offset === 0xffffffff || offset + tamanho > blob.size) throw new Error('Diretório ZIP inválido ou grande demais.');
  const dados = new Uint8Array(await blob.slice(offset, offset + tamanho).arrayBuffer());
  const dv = new DataView(dados.buffer);
  const entradas = [];
  let p = 0;
  for (let i = 0; i < quantidade; i++) {
    if (p + 46 > dados.length || u32(dv, p) !== 0x02014b50) throw new Error('Diretório ZIP truncado.');
    const nomeLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const comentarioLen = u16(dv, p + 32);
    const tamanhoRegistro = 46 + nomeLen + extraLen + comentarioLen;
    if (p + tamanhoRegistro > dados.length) throw new Error('Diretório ZIP truncado.');
    const nome = td.decode(dados.subarray(p + 46, p + 46 + nomeLen));
    const local = u32(dv, p + 42);
    if (local >= offset) throw new Error('Entrada ZIP fora do arquivo.');
    entradas.push({ nome, local, central: dados.slice(p, p + tamanhoRegistro) });
    p += tamanhoRegistro;
  }
  if (p !== dados.length || entradas.filter((e) => e.nome === 'modrinth.index.json').length !== 1) {
    throw new Error('O .mrpack não tem um índice único.');
  }
  return { entradas, offset };
}

function criarIndice(indice, offset) {
  const nome = texto.encode('modrinth.index.json');
  const dados = texto.encode(JSON.stringify(indice, null, 2));
  const crc = crc32(dados);
  const local = new Uint8Array(30);
  const lv = new DataView(local.buffer);
  w32(lv, 0, 0x04034b50);
  w16(lv, 4, 20);
  w16(lv, 6, 0x0800);
  w32(lv, 14, crc);
  w32(lv, 18, dados.length);
  w32(lv, 22, dados.length);
  w16(lv, 26, nome.length);

  const central = new Uint8Array(46);
  const cv = new DataView(central.buffer);
  w32(cv, 0, 0x02014b50);
  w16(cv, 4, 20);
  w16(cv, 6, 20);
  w16(cv, 8, 0x0800);
  w32(cv, 16, crc);
  w32(cv, 20, dados.length);
  w32(cv, 24, dados.length);
  w16(cv, 28, nome.length);
  w32(cv, 42, offset);
  return { local: [local, nome, dados], central: [central, nome], tamanho: local.length + nome.length + dados.length };
}

/** Baixa o original diretamente da Modrinth e troca somente o índice ZIP. */
export async function montarMrpackEditado(url, tamanhoEsperado, indice) {
  const alvo = new URL(url);
  if (alvo.protocol !== 'https:' || alvo.hostname !== 'cdn.modrinth.com') throw new Error('URL do .mrpack inesperada.');
  const resposta = await fetch(url);
  if (!resposta.ok) throw new Error(`Não consegui baixar o .mrpack original (HTTP ${resposta.status}).`);
  const original = await resposta.blob();
  if (tamanhoEsperado && original.size !== tamanhoEsperado) throw new Error('O tamanho do .mrpack original não confere.');
  if (original.size >= 0xffffffff) throw new Error('Este .mrpack usa ZIP64, que ainda não é suportado.');

  const { entradas, offset } = await lerDiretorio(original);
  const ordenadas = [...entradas].sort((a, b) => a.local - b.local);
  const partes = [];
  const centrais = [];
  let posicao = 0;
  for (let i = 0; i < ordenadas.length; i++) {
    const entrada = ordenadas[i];
    const fim = ordenadas[i + 1]?.local ?? offset;
    if (fim <= entrada.local || fim > offset) throw new Error('Entradas do ZIP sobrepostas.');
    if (entrada.nome === 'modrinth.index.json') continue;
    partes.push(original.slice(entrada.local, fim));
    const central = entrada.central.slice();
    w32(new DataView(central.buffer), 42, posicao);
    centrais.push(central);
    posicao += fim - entrada.local;
  }
  const novo = criarIndice(indice, posicao);
  partes.push(...novo.local);
  posicao += novo.tamanho;
  centrais.push(...novo.central);
  const tamanhoCentral = centrais.reduce((n, a) => n + a.length, 0);
  if (posicao + tamanhoCentral >= 0xffffffff || centrais.length > 65535) throw new Error('O .mrpack editado é grande demais para ZIP32.');
  const fim = new Uint8Array(22);
  const fv = new DataView(fim.buffer);
  w32(fv, 0, 0x06054b50);
  const quantidade = entradas.length;
  w16(fv, 8, quantidade);
  w16(fv, 10, quantidade);
  w32(fv, 12, tamanhoCentral);
  w32(fv, 16, posicao);
  return new Blob([...partes, ...centrais, fim], { type: 'application/x-modrinth-modpack+zip' });
}
