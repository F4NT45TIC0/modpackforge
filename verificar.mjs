
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { lerMetadadosBuffer } from './src/jarmeta.mjs';
import { auditarPack } from './src/auditoria.mjs';

const [pasta, ...args] = process.argv.slice(2);
const valor = (chave) => args[args.indexOf(chave) + 1];
if (!pasta || args.includes('--help')) {
  console.log('Uso: node verificar.mjs pasta/mods [--servidor] [--loader fabric|quilt|forge|neoforge] [--mc 1.21.1] [--loader-versao 0.16.14]');
  process.exit(pasta ? 0 : 1);
}
try {
  const loader = args.includes('--loader') ? valor('--loader') : null;
  if (loader && !['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) throw new Error('Loader invalido.');
  const registros = [];
  for (const nome of (await readdir(pasta)).filter((n) => /\.jar$/i.test(n))) {
    const arquivo = path.join(pasta, nome);
    registros.push({ chave: arquivo, nome, tipo: 'mod', arquivo: { nome },
      meta: await lerMetadadosBuffer(await readFile(arquivo), loader) });
  }
  if (!registros.length) throw new Error('Nenhum JAR encontrado.');
  const relatorio = auditarPack(registros, {
    lado: args.includes('--servidor') ? 'server' : 'client',
    loader, mc: args.includes('--mc') ? valor('--mc') : null,
    loaderVersao: args.includes('--loader-versao') ? valor('--loader-versao') : null,
  });
  console.log(`JARs conferidos: ${relatorio.verificados}/${relatorio.total}. Estado: ${relatorio.status}.`);
  for (const p of relatorio.bloqueios) console.log(`BLOQUEIO: ${p.texto}`);
  for (const p of relatorio.avisos) console.log(`AVISO: ${p.texto}`);
  console.log('A leitura das declaracoes nao confirma o boot. Para testar o servidor instalado, use bash verificar-servidor.sh.');
  process.exitCode = relatorio.bloqueios.length ? 1 : relatorio.avisos.length ? 2 : 0;
} catch (erro) {
  console.error(erro.message);
  process.exitCode = 1;
}
