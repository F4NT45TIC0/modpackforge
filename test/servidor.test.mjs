import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { criarVerificador } from '../src/verificador-servidor.mjs';

const bash = process.env.BASH_TEST_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const temBash = spawnSync(bash, ['--version']).status === 0;
const temSetsid = temBash && spawnSync(bash, ['-c', 'command -v setsid']).status === 0;
const unix = (p) => p.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`);
const aspas = (s) => `'${s.replace(/'/g, "'\\''")}'`;
function pasta(t) {
  const p = mkdtempSync(path.join(tmpdir(), 'mpf-regressao-'));
  t.after(() => {
    assert.ok(path.resolve(p).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(p, { recursive: true, force: true });
  });
  return p;
}

for (const publicado of [false, true]) for (const cenario of ['valido', 'corrompido', 'java-incompativel']) {
  const corrompido = cenario === 'corrompido', javaIncompativel = cenario === 'java-incompativel';
  const deveFalhar = corrompido || javaIncompativel;
  test(`instalador ${publicado ? 'publicado' : 'customizado'}: ${cenario}`, { skip: !temBash }, (t) => {
    const raiz = pasta(t), servidor = path.join(raiz, 'servidor'), bin = path.join(raiz, 'bin');
    mkdirSync(path.join(servidor, 'mods'), { recursive: true }); mkdirSync(bin);
    writeFileSync(path.join(raiz, 'mod.jar'), corrompido ? 'corrompido' : 'conteudo-mod');
    const sha = createHash('sha1').update('conteudo-mod').digest('hex');
    writeFileSync(path.join(servidor, '.modpackforge-loader'), 'fabric|1.21.1|0.16.14\n');
    writeFileSync(path.join(servidor, 'fabric-server-launch.jar'), 'stub-loader');
    writeFileSync(path.join(servidor, 'eula.txt'), 'eula=true\n'); // Fixture sem Minecraft.
    writeFileSync(path.join(servidor, 'mods/antigo.jar'), 'antigo');
    writeFileSync(path.join(servidor, 'mods/do-usuario.jar'), 'nao-gerenciado');
    const registro = path.join(servidor, publicado ? '.modpackforge-modpack-mods' : '.modpackforge-servidor');
    writeFileSync(registro, publicado ? 'mods/antigo.jar\n' : 'antigo.jar\n');
    writeFileSync(path.join(bin, 'java'), `#!/usr/bin/env bash\necho 'openjdk version "${javaIncompativel ? '25.0.1' : '21.0.7'}"' >&2\n`);
    writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then shift; destino="$1"; fi; shift; done\nprintf 'download\\n' >> ${aspas(unix(path.join(raiz, 'downloads')))}\ncp ${aspas(unix(path.join(raiz, 'mod.jar')))} "$destino"\n`);
    const valores = {
      PACK_NOME: publicado ? "'Teste'" : 'Teste', PACK_SLUG: publicado ? "'teste'" : 'teste', PACK_AUTOR: '',
      MC_VERSAO: publicado ? "'1.21.1'" : '1.21.1', LOADER_NOME: publicado ? "'fabric'" : 'fabric', LOADER_VERSAO: publicado ? "'0.16.14'" : '0.16.14',
      LOADER_LANCADOR: publicado ? "'fabric-server-launch.jar'" : 'fabric-server-launch.jar', LOADER_URL: "''", LOADER_JAR: "''", LOADER_ARGS: '',
      MEMORIA_MB: '4096', PORTA: '25565', TOTAL_MODS: '1', JAVA_MINIMO: '21', JAVA_PERMITIDOS: '21', SOMENTE_CLIENTE: '',
      MODS: `  "A|a.jar|${sha}|https://stub.test/a.jar"`, ARQUIVOS: `  'mods/a.jar|${sha}|https://stub.test/a.jar'`,
      OVERRIDES: '', EXCLUIDOS: '', PACK_URL: "'https://nao-deve-baixar.test/pack.mrpack'", PACK_SHA1: "''",
      VERIFICACAO: 'Teste de regressao', VERIFICADOR: criarVerificador(),
    };
    let script = readFileSync(new URL(`../src/instalador-${publicado ? 'modpack' : 'servidor'}.sh`, import.meta.url), 'utf8');
    for (const [chave, valor] of Object.entries(valores)) script = script.split(`@@${chave}@@`).join(valor);
    assert.ok(!script.includes('@@'));
    writeFileSync(path.join(raiz, 'instalar.sh'), script);
    writeFileSync(path.join(raiz, 'respostas'), `${unix(servidor)}\n`);
    const wrapper = `#!/usr/bin/env bash\nexport PATH=${aspas(unix(bin))}:"$PATH"\nchmod +x ${aspas(unix(bin))}/*\nexec bash ${aspas(unix(path.join(raiz, 'instalar.sh')))} < ${aspas(unix(path.join(raiz, 'respostas')))}\n`;
    writeFileSync(path.join(raiz, 'rodar.sh'), wrapper);
    const rodar = () => spawnSync(bash, [unix(path.join(raiz, 'rodar.sh'))], { cwd: raiz, encoding: 'utf8', timeout: 30000 });
    const r = rodar();
    assert.equal(r.status, deveFalhar ? 1 : 0, r.stdout + r.stderr);
    assert.equal(existsSync(path.join(servidor, 'mods/antigo.jar')), deveFalhar);
    assert.ok(existsSync(path.join(servidor, 'mods/do-usuario.jar')));
    if (javaIncompativel) assert.match(r.stdout + r.stderr, /Java incompativel/);
    if (!deveFalhar) {
      assert.ok(existsSync(path.join(servidor, 'verificar-servidor.sh')));
      assert.ok(existsSync(path.join(servidor, 'verificacao-pack.txt')));
      const segundo = rodar(); assert.equal(segundo.status, 0, segundo.stdout + segundo.stderr);
      assert.equal(readFileSync(path.join(raiz, 'downloads'), 'utf8').trim().split('\n').length, 1);
    }
  });
}

for (const caso of ['sucesso', 'crash', 'timeout', 'sem-eula']) {
  test(`teste de boot: ${caso}`, { skip: !temSetsid && caso !== 'sem-eula' }, (t) => {
    const raiz = pasta(t);
    writeFileSync(path.join(raiz, 'verificar-servidor.sh'), criarVerificador());
    if (caso !== 'sem-eula') writeFileSync(path.join(raiz, 'eula.txt'), 'eula=true\n');
    const corpo = caso === 'sucesso' ? 'echo "Done (1.0s)! For help, type help"\nwhile read -r comando; do [ "$comando" != stop ] || exit 0; done' : caso === 'crash' ? 'echo "Missing dependency"\nexit 1' : 'sleep 60';
    writeFileSync(path.join(raiz, 'iniciar.sh'), `#!/usr/bin/env bash\n${corpo}\n`);
    const r = spawnSync(bash, [unix(path.join(raiz, 'verificar-servidor.sh'))], { cwd: raiz, env: { ...process.env, MPF_TEMPO_TESTE: '5' }, timeout: 45000, encoding: 'utf8' });
    assert.equal(r.status, caso === 'sucesso' ? 0 : 1, r.stdout + r.stderr);
    if (caso === 'sucesso') assert.match(r.stdout, /Boot confirmado/);
    if (caso === 'crash') assert.match(r.stderr, /Missing dependency/);
    if (caso === 'sem-eula') assert.ok(!existsSync(path.join(raiz, 'eula.txt')));
  });
}
