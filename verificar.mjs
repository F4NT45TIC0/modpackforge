// Confere uma pasta de mods já instalada.
//
//   node verificar.mjs "caminho/para/a/pasta/mods"
//
// Lê cada .jar, monta a lista do que está realmente instalado — incluindo as
// bibliotecas que vêm embutidas dentro de outros jars — e confere todas as
// exigências, do mesmo jeito que o Fabric faz ao abrir o jogo. Serve para saber
// se um pack vai abrir sem precisar abrir.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { satisfaz, descreverExigencia } from './src/versoes.mjs';

const DO_AMBIENTE = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'mixinextras',
]);

// ------------------------------------------------------------------ leitura

function abrirZip(buf) {
  let fim = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) return null;

  const quantidade = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const entradas = new Map();
  for (let i = 0; i < quantidade && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const nomeLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comentarioLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    entradas.set(buf.toString('utf8', p + 46, p + 46 + nomeLen), { metodo, comprimido, local });
    p += 46 + nomeLen + extraLen + comentarioLen;
  }
  return entradas;
}

function extrair(buf, entrada) {
  const nomeLen = buf.readUInt16LE(entrada.local + 26);
  const extraLen = buf.readUInt16LE(entrada.local + 28);
  const inicio = entrada.local + 30 + nomeLen + extraLen;
  const dados = buf.subarray(inicio, inicio + entrada.comprimido);
  return entrada.metodo === 8 ? inflateRawSync(dados) : dados;
}

/** Alguns mods publicam fabric.mod.json com quebra de linha crua dentro de string. */
function lerJsonTolerante(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    const barra = String.fromCharCode(92);
    const aspas = String.fromCharCode(34);
    let saida = '';
    let dentro = false;
    let escapado = false;
    for (const c of texto) {
      if (escapado) { saida += c; escapado = false; continue; }
      if (c === barra) { saida += c; escapado = true; continue; }
      if (c === aspas) { dentro = !dentro; saida += c; continue; }
      const codigo = c.charCodeAt(0);
      if (dentro && codigo < 32) {
        saida += codigo === 10 ? barra + 'n' : codigo === 13 ? barra + 'r' : codigo === 9 ? barra + 't' : '';
        continue;
      }
      saida += c;
    }
    return JSON.parse(saida.replace(/,(\s*[}\]])/g, '$1'));
  }
}

/** Tudo que um jar entrega: ele mesmo, o que declara fornecer e o que traz embutido. */
function lerJar(caminho) {
  const buf = readFileSync(caminho);
  const entradas = abrirZip(buf);
  if (!entradas) return null;

  const principal = entradas.get('fabric.mod.json') ?? entradas.get('quilt.mod.json');
  if (!principal) return null;

  const j = lerJsonTolerante(extrair(buf, principal).toString('utf8'));
  const entrega = [{ id: j.id, versao: j.version }];
  for (const fornecido of j.provides ?? []) entrega.push({ id: fornecido, versao: j.version });

  for (const aninhado of j.jars ?? []) {
    const entrada = entradas.get(aninhado?.file);
    if (!entrada) continue;
    try {
      const interno = extrair(buf, entrada);
      const dentro = abrirZip(interno);
      const fmj = dentro?.get('fabric.mod.json');
      if (!fmj) continue;
      const sub = lerJsonTolerante(extrair(interno, fmj).toString('utf8'));
      if (sub.id) entrega.push({ id: sub.id, versao: sub.version });
      for (const fornecido of sub.provides ?? []) entrega.push({ id: fornecido, versao: sub.version });
    } catch {
      // um embutido ilegível não invalida o jar inteiro
    }
  }

  return { id: j.id, versao: j.version, depende: j.depends ?? {}, quebra: j.breaks ?? {}, entrega };
}

// ---------------------------------------------------------------- execução

const alvo = process.argv[2];
if (!alvo) {
  console.log('\n  Uso: node verificar.mjs "caminho para a pasta mods"\n');
  console.log('  Exemplos:');
  console.log('    node verificar.mjs "%APPDATA%\\PrismLauncher\\instances\\MeuPack\\minecraft\\mods"');
  console.log('    node verificar.mjs "%APPDATA%\\.minecraft\\modpacks\\meu-pack\\mods"\n');
  process.exit(1);
}

const pasta = path.resolve(alvo);
if (!existsSync(pasta) || !statSync(pasta).isDirectory()) {
  console.error(`\n  Não encontrei a pasta: ${pasta}\n`);
  process.exit(1);
}

const jars = readdirSync(pasta).filter((f) => f.toLowerCase().endsWith('.jar'));
if (!jars.length) {
  console.error(`\n  Nenhum .jar em ${pasta}\n`);
  process.exit(1);
}

const lidos = jars.map((f) => {
  try {
    return { arquivo: f, meta: lerJar(path.join(pasta, f)) };
  } catch {
    return { arquivo: f, meta: null };
  }
});

// O que está instalado, com a versão certa de cada peça.
const instalado = new Map();
for (const { arquivo, meta } of lidos) {
  if (!meta) continue;
  for (const { id, versao } of meta.entrega) {
    if (id && !instalado.has(id)) instalado.set(id, { versao, arquivo });
  }
}

console.log('');
console.log(`  ${pasta}`);
console.log(`  ${jars.length} arquivos · ${instalado.size} mods visíveis para o jogo (contando os embutidos)`);
console.log('');

const problemas = [];
const semLeitura = [];

for (const { arquivo, meta } of lidos) {
  if (!meta) { semLeitura.push(arquivo); continue; }

  for (const [id, faixa] of Object.entries(meta.depende)) {
    if (DO_AMBIENTE.has(id)) continue;
    const presente = instalado.get(id);
    if (!presente) {
      problemas.push(`${meta.id} precisa de "${id}" ${descreverExigencia(faixa)}, que não está instalado.`);
      continue;
    }
    if (!satisfaz(presente.versao, faixa, 'fabric')) {
      problemas.push(
        `${meta.id} precisa de "${id}" ${descreverExigencia(faixa)}, mas a versão instalada é ${presente.versao}.`,
      );
    }
  }

  for (const [id, faixa] of Object.entries(meta.quebra)) {
    const presente = instalado.get(id);
    if (!presente) continue;
    if (satisfaz(presente.versao, faixa, 'fabric')) {
      problemas.push(`${meta.id} ${meta.versao} não funciona com "${id}" ${presente.versao}.`);
    }
  }
}

if (semLeitura.length) {
  console.log(`  ${semLeitura.length} arquivos sem metadados legíveis (podem não ser mods de Fabric):`);
  for (const f of semLeitura) console.log(`    ${f}`);
  console.log('');
}

if (problemas.length) {
  console.log(`  ${problemas.length} ${problemas.length === 1 ? 'problema' : 'problemas'}:`);
  for (const p of [...new Set(problemas)]) console.log(`    ${p}`);
  console.log('');
  console.log('  Este pack não vai abrir. Gere de novo no ModpackForge.');
  console.log('');
  process.exit(2);
}

console.log('  Nenhuma exigência violada. Este pack abre.');
console.log('');
