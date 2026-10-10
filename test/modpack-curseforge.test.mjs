import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { arquivosDoServerpack, alvoDoManifesto, prepararModpackCurseforge } from '../src/modpack-curseforge.mjs';
import { montarZip } from '../src/zip.mjs';
import { tratarApi } from '../src/api.mjs';
import { limparCache } from '../src/http.mjs';

const entrada = { metodo: 0, descomprimido: 20, flags: 0, tipoUnix: 0x8000 };
test('serverpack: remove pasta de topo, preserva config e guarda scripts originais', () => {
  const arquivos = arquivosDoServerpack(new Map(['pack/mods/a.jar', 'pack/config/a.toml', 'pack/run.sh', 'pack/eula.txt'].map(p=>[p,entrada])));
  assert.deepEqual(arquivos.map(a=>a.destino), ['mods/a.jar','config/a.toml','.modpackforge-oficial/run.sh']);
  assert.equal(arquivos[0].origem, 'pack/mods/a.jar');
  assert.equal(arquivosDoServerpack(new Map([['config/a.toml',entrada]]))[0].destino, 'config/a.toml');
});
test('serverpack: recusa travessia, duplicados, symlink e ZIP criptografado', () => {
  for (const p of ['../mods/a.jar','pack/config/../a.toml','/mods/a.jar','mods/a|b.jar']) {
    assert.throws(()=>arquivosDoServerpack(new Map([[p,entrada]])), /inválida/);
  }
  assert.throws(()=>arquivosDoServerpack(new Map([['mods/A.jar',entrada],['mods/a.jar',entrada]])), /duplicado/);
  for (const extra of [{tipoUnix:0xa000},{flags:1}]) assert.throws(()=>arquivosDoServerpack(new Map([['mods/a.jar',{...entrada,...extra}]])), /inválida/);
});
test('manifesto: identifica Forge/NeoForge e rejeita loader ambíguo', () => {
  const base={manifestType:'minecraftModpack',minecraft:{version:'1.20.1',modLoaders:[{id:'forge-1.20.1-47.3.0',primary:true}]}};
  assert.deepEqual(alvoDoManifesto(base), {mc:'1.20.1',loader:'forge',loaderVersao:'47.3.0'});
  assert.equal(alvoDoManifesto({...base,minecraft:{version:'1.21.1',modLoaders:[{id:'neoforge-21.1.200'}]}}).loader,'neoforge');
  assert.throws(()=>alvoDoManifesto({...base,minecraft:{version:'1.20.1',modLoaders:[{id:'forge-47.3.0'},{id:'fabric-0.16.14'}]}}), /manifesto/);
});

const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
const temBash=spawnSync(bash,['--version']).status===0;
const python=process.env.MPF_PYTHON_TEST_BIN??(process.platform==='win32'
  ? path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'):'python3');
const temPython=spawnSync(python,['--version']).status===0;
const unix=p=>p.replace(/\\/g,'/').replace(/^([a-z]):/i,(_,d)=>`/${d.toLowerCase()}`);
const aspas=s=>`'${s.replace(/'/g,"'\\''")}'`;

test('CurseForge: catálogo, versão vinculada, downloads e instalação oficial com configs', async t => {
  const anteriorFetch=globalThis.fetch, chave=process.env.CURSEFORGE_API_KEY;
  process.env.CURSEFORGE_API_KEY='chave-de-fixture'; limparCache();
  t.after(()=>{ globalThis.fetch=anteriorFetch; if(chave===undefined) delete process.env.CURSEFORGE_API_KEY; else process.env.CURSEFORGE_API_KEY=chave; limparCache(); });
  const urls=['https://mediafilez.forgecdn.net/files/1000/1/client.zip','https://mediafilez.forgecdn.net/files/1000/2/server.zip'];
  const manifesto={manifestType:'minecraftModpack',minecraft:{version:'1.20.1',modLoaders:[{id:'forge-47.3.0',primary:true}]}};
  const zips=[montarZip([{caminho:'manifest.json',dados:JSON.stringify(manifesto)}]),montarZip([
    {caminho:'pack/mods/[1.20.1] a.jar',dados:'mod-fixture'}, {caminho:'pack/config/a.toml',dados:'do-autor=true\n'},
    {caminho:'pack/run.sh',dados:'echo script original\n'}, {caminho:'pack/server.properties',dados:'server-port=25565\nmotd=Autor\n'},
    {caminho:'pack/eula.txt',dados:'eula=true\n'},
  ])];
  const arquivos=zips.map((b,i)=>({id:41+i,modId:420,displayName:i?'Server':'Client',fileName:i?'server.zip':'client.zip',downloadUrl:urls[i].replace('mediafilez.forgecdn.net','edge.forgecdn.net'),fileLength:b.length,
    hashes:[{algo:1,value:createHash('sha1').update(b).digest('hex')}],gameVersions:['1.20.1','Forge'],isServerPack:i===1,serverPackFileId:i?null:42,parentProjectFileId:i?41:null}));
  const projeto={id:420,classId:4471,name:'Pack Forge',slug:'pack-forge',links:{websiteUrl:'https://www.curseforge.com/minecraft/modpacks/pack-forge'}};
  const pedidos=[];
  globalThis.fetch=async (url,opcoes={})=>{
    const u=new URL(url); pedidos.push(u.href);
    if(u.hostname==='api.curseforge.com') {
      assert.equal(opcoes.headers['x-api-key'],'chave-de-fixture');
      const data=u.pathname.endsWith('/search')?[projeto]:u.pathname.endsWith('/files')?arquivos:u.pathname.endsWith('/files/41')?arquivos[0]:u.pathname.endsWith('/files/42')?arquivos[1]:projeto;
      return Response.json({data,pagination:{totalCount:1}});
    }
    const b=zips[urls.indexOf(u.href)]; assert.ok(b);
    const range=opcoes.headers.Range;
    if(!range) return new Response(b,{headers:{'content-length':String(b.length)}});
    const match=/bytes=(\d*)-(\d*)/.exec(range);
    const inicio=match[1]?Number(match[1]):Math.max(0,b.length-Number(match[2]));
    const fim=match[1]?Math.min(b.length-1,Number(match[2])):b.length-1;
    return new Response(b.subarray(inicio,fim+1),{status:206,headers:{'content-range':`bytes ${inicio}-${fim}/${b.length}`}});
  };
  const chamar=async (rota,corpo)=>{
    const r=await tratarApi(new Request('https://teste.invalid/api/'+rota,corpo?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(corpo)}:{}),{nuvem:true});
    const dados=await r.json(); assert.equal(r.status,200,JSON.stringify(dados)); return dados;
  };
  const busca=await chamar('buscar?loader=forge&mc=1.20.1&tipo=modpack&fontes=curseforge');
  assert.equal(busca.itens[0].tipo,'modpack'); assert.equal(new URL(pedidos.find(p=>p.includes('/search?'))).searchParams.get('classId'),'4471');
  const detalhe=await chamar('projeto?fonte=curseforge&id=420&tipo=modpack&loader=forge&mc=1.20.1');
  assert.equal(detalhe.versoes.length,1); assert.equal(detalhe.versoes[0].serverPackId,'42');
  const pack=await chamar('baixar-modpack',{fonte:'curseforge',projetoId:'420',versaoId:'41',porta:25570});
  assert.equal(pack.resumo.loaderVersao,'47.3.0'); assert.equal(pack.serverpack.url,urls[1]);
  assert.equal(pack.resumo.verificacao.status,'incompleta');
  const script=Buffer.from(pack.servidor.base64,'base64').toString(); assert.ok(!script.includes('@@')); assert.ok(!script.includes('chave-de-fixture'));
  if(!temBash || !temPython) return;
  const raiz=mkdtempSync(path.join(tmpdir(),'mpf-cf-'));
  t.after(()=>{assert.ok(path.resolve(raiz).startsWith(path.resolve(tmpdir())+path.sep));rmSync(raiz,{recursive:true,force:true});});
  const servidor=path.join(raiz,'server'),bin=path.join(raiz,'bin');mkdirSync(bin);mkdirSync(path.join(servidor,'config'),{recursive:true});
  writeFileSync(path.join(servidor,'config/a.toml'),'personalizado=true\n');
  writeFileSync(path.join(raiz,'server.zip'),zips[1]); writeFileSync(path.join(raiz,'instalar.sh'),script);
  writeFileSync(path.join(bin,'curl'),`#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; destino="$1"; fi; shift; done\nprintf 'download\\n' >> ${aspas(unix(path.join(raiz,'downloads')))}\ncp ${aspas(unix(path.join(raiz,'server.zip')))} "$destino"\n`);
  writeFileSync(path.join(bin,'java'),`#!/usr/bin/env bash\nif [ "$1" = -version ]; then echo 'openjdk version "17.0.1"' >&2; exit 0; fi\nprintf '#!/usr/bin/env bash\\necho loader-generated\\n' > run.sh\n`);
  writeFileSync(path.join(bin,'python3'),`#!/usr/bin/env bash\nexec ${aspas(unix(python))} "$@"\n`);
  writeFileSync(path.join(raiz,'respostas'),unix(servidor)+'\n');
  writeFileSync(path.join(raiz,'rodar.sh'),`#!/usr/bin/env bash\nexport PATH=${aspas(unix(bin))}:"$PATH"\nchmod +x ${aspas(unix(bin))}/*\nexec bash instalar.sh < respostas\n`);
  const r=spawnSync(bash,[unix(path.join(raiz,'rodar.sh'))],{cwd:raiz,encoding:'utf8',timeout:20000});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(readFileSync(path.join(servidor,'mods/[1.20.1] a.jar'),'utf8'),'mod-fixture');
  assert.equal(readFileSync(path.join(servidor,'config/a.toml'),'utf8'),'do-autor=true\n');
  assert.match(readFileSync(path.join(servidor,'server.properties'),'utf8'),/server-port=25570\nmotd=Autor/);
  assert.match(readFileSync(path.join(servidor,'run.sh'),'utf8'),/loader-generated/);
  assert.match(readFileSync(path.join(servidor,'.modpackforge-oficial/run.sh'),'utf8'),/original/);
  assert.equal(readFileSync(path.join(servidor,'.modpackforge-modpack-mods'),'utf8'),'mods/[1.20.1] a.jar\n');
  assert.ok(!existsSync(path.join(servidor,'eula.txt'))); // ZIP não aceita o EULA pelo usuário.
  assert.ok(existsSync(path.join(servidor,'verificar-servidor.sh')));
  const novamente=spawnSync(bash,[unix(path.join(raiz,'rodar.sh'))],{cwd:raiz,encoding:'utf8',timeout:20000});
  assert.equal(novamente.status,0,novamente.stdout+novamente.stderr);
  assert.match(novamente.stdout,/Reaproveitando o ZIP conferido/);
  assert.match(novamente.stdout,/reaproveitados/);
  assert.equal(readFileSync(path.join(raiz,'downloads'),'utf8').trim().split('\n').length,2); // ZIP + instalador do loader, só na primeira vez.
  // Forge anterior ao run.sh precisa iniciar o Forge, mesmo havendo server.jar.
  rmSync(path.join(servidor,'run.sh'));
  writeFileSync(path.join(servidor,'server.jar'),'vanilla');
  writeFileSync(path.join(servidor,'forge-1.20.1-47.3.0.jar'),'forge-fixture');
  writeFileSync(path.join(bin,'java'),'#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  writeFileSync(path.join(raiz,'iniciar-teste.sh'),`#!/usr/bin/env bash\nexport PATH=${aspas(unix(bin))}:"$PATH"\ncd ${aspas(unix(servidor))}\nexec bash iniciar.sh\n`);
  const inicioTeste=spawnSync(bash,[unix(path.join(raiz,'iniciar-teste.sh'))],{cwd:raiz,encoding:'utf8'});
  assert.equal(inicioTeste.status,0,inicioTeste.stderr); assert.match(inicioTeste.stdout,/forge-1.20.1-47.3.0.jar/);
  assert.ok(!inicioTeste.stdout.includes('\nserver.jar\n'));
});

test('CurseForge: sem serverpack mantém download de cliente; arquivo vinculado errado é recusado',async()=>{
  const projeto={id:'420',tipo:'modpack',nome:'Pack',pagina:'https://www.curseforge.com/minecraft/modpacks/pack'};
  const cliente={id:'41',projetoId:'420',arquivo:{nome:'client.zip',url:null},versoesJogo:['1.20.1'],loaders:['forge']};
  const provider={projeto:async()=>projeto,versaoPorId:async()=>cliente};
  const sem=await prepararModpackCurseforge('420','41',{}, {provider});
  assert.equal(sem.servidor,null); assert.ok(sem.resumo.avisos[0].includes('não tem serverpack'));
  const errado={...provider,versaoPorId:async(_,id)=>id==='41'?{...cliente,serverPackId:'42'}:{...cliente,id:'42',ehServerpack:true,versaoClienteId:'99'}};
  await assert.rejects(prepararModpackCurseforge('420','41',{}, {provider:errado}),/não corresponde/);
  const restrito={...provider,versaoPorId:async(_,id)=>id==='41'?{...cliente,serverPackId:'42'}:{...cliente,id:'42',ehServerpack:true,versaoClienteId:'41'}};
  const bloqueado=await prepararModpackCurseforge('420','41',{}, {provider:restrito,diretorio:()=>{throw new Error('não deve baixar');}});
  assert.equal(bloqueado.servidor,null); assert.ok(bloqueado.serverpack.pagina.endsWith('/files/42'));
  assert.match(bloqueado.resumo.avisos[0],/autor não liberou/);
});
