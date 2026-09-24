// Escritor de ZIP mínimo. O Node traz deflate em node:zlib mas não o formato ZIP,
// e o .mrpack é só um ZIP com um índice JSON dentro. São ~80 linhas; não vale
// arrastar uma dependência por isso.

import { deflateRawSync } from 'node:zlib';

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = TABELA_CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Data/hora no formato MS-DOS que o cabeçalho do ZIP usa. */
function dataDos(data) {
  const hora =
    (data.getHours() << 11) | (data.getMinutes() << 5) | (Math.floor(data.getSeconds() / 2) & 0x1f);
  const dia =
    ((data.getFullYear() - 1980) << 9) | ((data.getMonth() + 1) << 5) | data.getDate();
  return { hora, dia };
}

/**
 * @param {Array<{caminho:string, dados:Buffer|string}>} entradas
 * @returns {Buffer}
 */
export function montarZip(entradas) {
  const agora = dataDos(new Date());
  const locais = [];
  const central = [];
  let deslocamento = 0;

  for (const entrada of entradas) {
    const nome = Buffer.from(entrada.caminho.replace(/\\/g, '/'), 'utf8');
    const cru = Buffer.isBuffer(entrada.dados) ? entrada.dados : Buffer.from(entrada.dados, 'utf8');
    const crc = crc32(cru);

    const comprimido = deflateRawSync(cru, { level: 9 });
    // Se comprimir não ajudou, guarda sem compressão (método 0).
    const usaDeflate = comprimido.length < cru.length;
    const corpo = usaDeflate ? comprimido : cru;
    const metodo = usaDeflate ? 8 : 0;

    const cabecalhoLocal = Buffer.alloc(30);
    cabecalhoLocal.writeUInt32LE(0x04034b50, 0);
    cabecalhoLocal.writeUInt16LE(20, 4); // versão necessária
    cabecalhoLocal.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    cabecalhoLocal.writeUInt16LE(metodo, 8);
    cabecalhoLocal.writeUInt16LE(agora.hora, 10);
    cabecalhoLocal.writeUInt16LE(agora.dia, 12);
    cabecalhoLocal.writeUInt32LE(crc, 14);
    cabecalhoLocal.writeUInt32LE(corpo.length, 18);
    cabecalhoLocal.writeUInt32LE(cru.length, 22);
    cabecalhoLocal.writeUInt16LE(nome.length, 26);
    cabecalhoLocal.writeUInt16LE(0, 28);

    locais.push(cabecalhoLocal, nome, corpo);

    const cabecalhoCentral = Buffer.alloc(46);
    cabecalhoCentral.writeUInt32LE(0x02014b50, 0);
    cabecalhoCentral.writeUInt16LE(20, 4); // versão que criou
    cabecalhoCentral.writeUInt16LE(20, 6); // versão necessária
    cabecalhoCentral.writeUInt16LE(0x0800, 8);
    cabecalhoCentral.writeUInt16LE(metodo, 10);
    cabecalhoCentral.writeUInt16LE(agora.hora, 12);
    cabecalhoCentral.writeUInt16LE(agora.dia, 14);
    cabecalhoCentral.writeUInt32LE(crc, 16);
    cabecalhoCentral.writeUInt32LE(corpo.length, 20);
    cabecalhoCentral.writeUInt32LE(cru.length, 24);
    cabecalhoCentral.writeUInt16LE(nome.length, 28);
    cabecalhoCentral.writeUInt32LE(deslocamento, 42);

    central.push(cabecalhoCentral, nome);
    deslocamento += cabecalhoLocal.length + nome.length + corpo.length;
  }

  const blocoCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(blocoCentral.length, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...locais, blocoCentral, fim]);
}
