import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { montarZip } from '../src/zip.mjs';

const python=process.env.MPF_PYTHON_TEST_BIN??(process.platform==='win32'
  ? path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'):'python3');
const temPython=spawnSync(python,['--version']).status===0;
const programa=new URL('../src/extrair-pack.py',import.meta.url);

test('extrator: milhares de arquivos, nomes literais, progresso e retomada sem substituir arquivos corretos', {skip:!temPython},t=>{
  const raiz=mkdtempSync(path.join(tmpdir(),'mpf-extracao-'));
  t.after(()=>{assert.ok(path.resolve(raiz).startsWith(path.resolve(tmpdir())+path.sep));rmSync(raiz,{recursive:true,force:true});});
  const servidor=path.join(raiz,'server'),backup=path.join(servidor,'.modpackforge-backups/teste');
  mkdirSync(path.join(servidor,'mods'),{recursive:true});mkdirSync(path.join(servidor,'config'));
  writeFileSync(path.join(servidor,'mods/[1.20.1] ja-existe.jar'),'mesmo-conteudo');
  writeFileSync(path.join(servidor,'config/a.toml'),'personalizado=true');
  const entradas=[{caminho:'mods/[1.20.1] ja-existe.jar',dados:'mesmo-conteudo'},{caminho:'config/a.toml',dados:'autor=true'},
    ...Array.from({length:2000},(_,i)=>({caminho:`config/pack/item-${i}.json`,dados:JSON.stringify({item:i,payload:'x'.repeat(4096)})}))];
  writeFileSync(path.join(raiz,'pack.zip'),montarZip(entradas));
  writeFileSync(path.join(raiz,'plano.txt'),entradas.map(e=>`${e.caminho}|${e.caminho}`).join('\n'));
  const rodar=(plano='plano.txt')=>spawnSync(python,[programa.pathname.replace(/^\/([a-z]:)/i,'$1'),path.join(raiz,'pack.zip'),servidor,backup,path.join(raiz,plano)],{encoding:'utf8',timeout:20000});
  const primeiro=rodar();assert.equal(primeiro.status,0,primeiro.stderr);assert.match(primeiro.stdout,/2002\/2002 \(1 reaproveitados\)/);
  assert.equal(readFileSync(path.join(backup,'config/a.toml'),'utf8'),'personalizado=true');
  assert.equal(readdirSync(path.join(servidor,'config/pack')).length,2000);
  const segundo=rodar();assert.equal(segundo.status,0,segundo.stderr);assert.match(segundo.stdout,/2002\/2002 \(2002 reaproveitados\)/);
  // Uma falha antes de extrair nunca sobrescreve a config atual.
  writeFileSync(path.join(raiz,'invalido.txt'),'config/a.toml|config/a.toml\nconfig/ausente|config/ausente');
  const invalido=rodar('invalido.txt');assert.equal(invalido.status,1);assert.equal(readFileSync(path.join(servidor,'config/a.toml'),'utf8'),'autor=true');
  writeFileSync(path.join(raiz,'invalido.txt'),'config/a.toml|../fora.toml');
  assert.equal(rodar('invalido.txt').status,1);assert.ok(!existsSync(path.join(raiz,'fora.toml')));
  // Um destino previamente ligado para fora do servidor também é recusado.
  if(process.platform!=='win32') {
    mkdirSync(path.join(raiz,'fora'));symlinkSync(path.join(raiz,'fora'),path.join(servidor,'link'));
    writeFileSync(path.join(raiz,'invalido.txt'),'config/a.toml|link/a.toml');
    assert.equal(rodar('invalido.txt').status,1);assert.ok(!existsSync(path.join(raiz,'fora/a.toml')));
  }
});
