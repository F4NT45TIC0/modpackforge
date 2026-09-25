import { inflateRawSync } from 'node:zlib';

/** Lê o índice central de um .mrpack sem extrair arquivos no disco. */
export function lerEntradasZip(buffer) {
  const inicioBusca = Math.max(0, buffer.length - 65557);
  let fim = -1;
  for (let i = buffer.length - 22; i >= inicioBusca; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) throw new Error('O arquivo não é um .mrpack válido.');
  const quantidade = buffer.readUInt16LE(fim + 10);
  let pos = buffer.readUInt32LE(fim + 16);
  if (quantidade > 5000 || pos >= buffer.length) throw new Error('Índice do .mrpack inválido.');
  const entradas = new Map();
  for (let i = 0; i < quantidade; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP truncado.');
    const metodo = buffer.readUInt16LE(pos + 10);
    const tamanho = buffer.readUInt32LE(pos + 20);
    const descomprimido = buffer.readUInt32LE(pos + 24);
    const nomeLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const comentarioLen = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const nome = buffer.toString('utf8', pos + 46, pos + 46 + nomeLen);
    if (pos + 46 + nomeLen + extraLen + comentarioLen > buffer.length || entradas.has(nome)) throw new Error('Índice do ZIP inválido.');
    entradas.set(nome, { metodo, tamanho, descomprimido, local });
    pos += 46 + nomeLen + extraLen + comentarioLen;
  }
  return entradas;
}

export function lerArquivoZip(buffer, entrada, limite = 2 * 1024 * 1024) {
  if (!entrada || entrada.descomprimido > limite || ![0, 8].includes(entrada.metodo)) throw new Error('Entrada ZIP inválida ou grande demais.');
  const p = entrada.local;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== 0x04034b50) throw new Error('Entrada ZIP truncada.');
  const inicio = p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28);
  if (inicio + entrada.tamanho > buffer.length) throw new Error('Entrada ZIP truncada.');
  const dados = buffer.subarray(inicio, inicio + entrada.tamanho);
  const saida = entrada.metodo === 8 ? inflateRawSync(dados, { maxOutputLength: limite }) : dados;
  if (saida.length !== entrada.descomprimido) throw new Error('Tamanho da entrada ZIP não confere.');
  return saida;
}
