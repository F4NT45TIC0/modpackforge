import test from 'node:test';
import assert from 'node:assert/strict';
import { montarZip } from '../src/zip.mjs';
import { lerMetadadosBuffer, lerMetadados } from '../src/jarmeta.mjs';
import { auditarPack, exigirServidorValido, javaDoMinecraft } from '../src/auditoria.mjs';
import { separarPorLado } from '../src/exportar-servidor.mjs';
import { mesmoMod } from '../web/compartilhado/conflitos.mjs';
import { ajustar } from '../src/compatibilidade.mjs';
import { resolver } from '../src/resolver.mjs';
import { limparCache } from '../src/http.mjs';
import { buscarArquivoPublico } from '../src/arquivo-publico.mjs';

const alvo = { loader: 'fabric', mc: '1.21.1', loaderVersao: '0.16.14' };
const jar = (j, extras = []) => montarZip([{ caminho: 'fabric.mod.json', dados: JSON.stringify({ schemaVersion: 1, version: '1.0.0', environment: '*', ...j }) }, ...extras]);
const registro = (nome, meta, extras = {}) => ({ nome, chave: nome, tipo: 'mod', meta, ...extras });

test('le todos os 40 JARs embutidos, inclusive versoes e aninhamento recursivo', async () => {
  const filhos = Array.from({ length: 40 }, (_, i) => ({ caminho: `jars/lib${i}.jar`, dados: jar({ id: `lib${i}`, version: `${i}.0.0` }) }));
  const profundo = jar({ id: 'profundo' });
  filhos[39].dados = jar({ id: 'lib39', version: '39.0.0', jars: [{ file: 'deep.jar' }] }, [{ caminho: 'deep.jar', dados: profundo }]);
  const meta = await lerMetadadosBuffer(jar({ id: 'pacote', jars: filhos.map((e) => ({ file: e.caminho })) }, filhos), 'fabric');
  assert.equal(meta.versaoDe.lib39, '39.0.0');
  assert.ok(meta.fornece.includes('profundo'));
  const consumidor = await lerMetadadosBuffer(jar({ id: 'consumidor', depends: { lib39: '>=39.0.0', profundo: '*' } }), 'fabric');
  assert.equal(auditarPack([registro('Pacote', meta), registro('Consumidor', consumidor)], alvo).bloqueios.length, 0);
});

test('Quilt usa quilt_loader e fornece a versao declarada de seus aliases', async () => {
  const buf = montarZip([{ caminho: 'quilt.mod.json', dados: JSON.stringify({ quilt_loader: {
    id: 'quiltlib', version: '2.0.0', provides: [{ id: 'alias', version: '1.0.0' }], depends: [{ id: 'minecraft', versions: '>=1.21' }],
  }, minecraft: { environment: 'client' } }) }]);
  const meta = await lerMetadadosBuffer(buf, 'quilt');
  assert.equal(meta.modId, 'quiltlib'); assert.equal(meta.versaoDe.alias, '1.0.0'); assert.equal(meta.ambiente, 'client');
});

test('Forge respeita CLIENT/SERVER, todos os IDs e versao do manifesto', async () => {
  const toml = `[[mods]]\nmodId="principal"\nversion="\${file.jarVersion}"\n[[mods]]\nmodId="segundo"\nversion="2.0.0"\n[[dependencies.principal]]\nmodId="tela"\nmandatory=true\nside="CLIENT"\n[[dependencies.segundo]]\nmodId="rede"\ntype="required"\nside="SERVER"\nversionRange="[1.0,2.0)"`;
  const meta = await lerMetadadosBuffer(montarZip([{ caminho: 'META-INF/mods.toml', dados: toml }, { caminho: 'META-INF/MANIFEST.MF', dados: 'Implementation-Version: 3.0.0\r\n' }]), 'forge');
  assert.equal(meta.versao, '3.0.0'); assert.ok(meta.fornece.includes('segundo'));
  assert.deepEqual(meta.dependeServidor, { rede: '[1.0,2.0)' }); assert.deepEqual(meta.dependeCliente, { tela: '*' });
  const r = auditarPack([registro('Forge mod', meta)], { loader: 'forge', mc: '1.20.1', loaderVersao: '47.4.0' });
  assert.ok(r.bloqueios.some((p) => p.texto.includes('rede'))); assert.ok(!r.bloqueios.some((p) => p.texto.includes('tela')));
});

test('seleciona o descritor do loader em JAR com varias plataformas', async () => {
  const buf = montarZip([{ caminho: 'fabric.mod.json', dados: '{"id":"fabric_id","version":"1"}' }, { caminho: 'META-INF/neoforge.mods.toml', dados: '[[mods]]\nmodId="neo_id"\nversion="2"' }]);
  assert.equal((await lerMetadadosBuffer(buf, 'neoforge')).modId, 'neo_id');
});

test('NeoForge tambem le o descritor mods.toml das versoes antigas', async () => {
  const meta = await lerMetadadosBuffer(montarZip([{ caminho: 'META-INF/mods.toml', dados: '[[mods]]\nmodId="neo_antigo"\nversion="1.0.0"' }]), 'neoforge');
  assert.equal(meta.modId, 'neo_antigo'); assert.equal(meta.tipo, 'neoforge'); assert.equal(meta.ambiente, 'unknown');
});

test('Forge ignora descricao multiline, confere opcionais presentes e Java features', async () => {
  const texto = `[[mods]]\nmodId="principal"\nversion="1"\ndescription='''\n[[mods]]\nmodId="nao_e_um_mod"\n'''\n[features.principal]\njavaVersion="[25,)"\n[[dependencies.principal]]\nmodId="opcional"\ntype="optional"\nversionRange="[2,3)"\nside="BOTH"`;
  const meta = await lerMetadadosBuffer(montarZip([{ caminho: 'META-INF/neoforge.mods.toml', dados: texto }]), 'neoforge');
  assert.deepEqual(meta.idsPrincipais, ['principal']);
  const r = auditarPack([registro('Principal', meta)], { loader: 'neoforge', mc: '1.21.1', loaderVersao: '21.1.0' });
  assert.equal(r.javaMinimo, 25); assert.equal(r.bloqueios.length, 0);
  const opcional = await lerMetadadosBuffer(jar({ id: 'opcional', version: '1.0.0' }));
  assert.ok(auditarPack([registro('Principal', meta), registro('Opcional', opcional)], { loader: 'neoforge', mc: '1.21.1', loaderVersao: '21.1.0' }).bloqueios.some((p) => p.tipo === 'versao-incompativel'));
});

test('enderecos privados dentro de um modpack nao sao acessados pela API', async () => {
  for (const url of ['https://127.0.0.1/a.jar', 'https://10.0.0.1/a.jar', 'https://[::1]/a.jar', 'https://[::ffff:127.0.0.1]/a.jar', 'https://localhost/a.jar']) {
    await assert.rejects(buscarArquivoPublico(url), /privada|invalido/);
  }
});

test('CDN que ignora Range nao faz os offsets do JAR quebrarem', async (t) => {
  const buf = jar({ id: 'sem_range' }, [{ caminho: 'ruido', dados: Buffer.from(Array.from({ length: 90000 }, (_, i) => i % 251)) }]);
  t.mock.method(globalThis, 'fetch', async () => new Response(buf, { headers: { 'content-length': String(buf.length) } }));
  const meta = await lerMetadados('https://exemplo.test/range-ignorado.jar', buf.length, 'fabric');
  assert.equal(meta.modId, 'sem_range');
});

test('nao recoloca mod exclusivo do cliente para satisfazer servidor', async () => {
  const c = registro('Tela', await lerMetadadosBuffer(jar({ id: 'tela', environment: 'client' })));
  const s = registro('Servidor', await lerMetadadosBuffer(jar({ id: 'servidor', depends: { tela: '*' } })));
  const lados = separarPorLado([s, c]);
  assert.deepEqual(lados.servidor.map((r) => r.nome), ['Servidor']);
  const r = auditarPack(lados.servidor, alvo);
  assert.equal(r.status, 'bloqueado'); assert.throws(() => exigirServidorValido(r), /tela/);
});

test('biblioteca embutida de cliente nao satisfaz dependencia do servidor', async () => {
  const meta = await lerMetadadosBuffer(jar({ id: 'pai', jars: [{ file: 'client.jar' }], depends: { tela: '*' } }, [{ caminho: 'client.jar', dados: jar({ id: 'tela', environment: 'client' }) }]));
  assert.equal(auditarPack([registro('Pai', meta)], alvo).status, 'bloqueado');
  assert.equal(auditarPack([registro('Pai', meta)], { ...alvo, lado: 'client' }).status, 'declaracoes-conferidas');
});

test('recupera biblioteca rotulada cliente quando o JAR declara ambos os lados', async () => {
  const biblioteca = registro('Biblioteca', await lerMetadadosBuffer(jar({ id: 'biblioteca', environment: '*' })), { ladoServidor: 'unsupported' });
  const consumidor = registro('Consumidor', await lerMetadadosBuffer(jar({ id: 'consumidor', depends: { biblioteca: '*' } })));
  const lados = separarPorLado([consumidor, biblioteca]);
  assert.equal(lados.servidor.length, 2);
  assert.equal(auditarPack(lados.servidor, alvo).bloqueios.length, 0);
});

test('biblioteca Java 25 opcional do C2ME nao impede um pack que exige Java 21', async () => {
  const embutido = { caminho: 'java25.jar', dados: jar({ id: 'otimizacao_java25', depends: { java: '>=25' } }) };
  const meta = await lerMetadadosBuffer(jar({ id: 'c2me', jars: [{ file: embutido.caminho }] }, [embutido]));
  const cobblemon = await lerMetadadosBuffer(jar({ id: 'cobblemon', depends: { java: '21' } }));
  const r = auditarPack([registro('C2ME', meta), registro('Cobblemon', cobblemon)], alvo);
  assert.equal(r.bloqueios.length, 0); assert.equal(r.javaMinimo, 21);
  const exige = await lerMetadadosBuffer(jar({ id: 'exige', depends: { otimizacao_java25: '*' } }));
  assert.equal(auditarPack([registro('C2ME', meta), registro('Cobblemon', cobblemon), registro('Exige', exige)], alvo).status, 'bloqueado');
});

test('o mesmo mod nas duas lojas e detectado por ID mesmo com nomes diferentes', async () => {
  const meta = await lerMetadadosBuffer(jar({ id: 'o_mesmo' }));
  const a = registro('Nome da Modrinth', meta, { fonte: 'modrinth' }), b = registro('Titulo CurseForge', meta, { fonte: 'curseforge' });
  assert.ok(mesmoMod(a, b)); assert.ok(auditarPack([a, b], alvo).bloqueios.some((p) => p.tipo === 'duplicado'));
  assert.ok(mesmoMod({ fonte: 'curseforge', slug: 'great-mod', nome: 'Outro titulo' }, { fonte: 'modrinth', slug: 'great-mod', nome: 'Great Mod' }));
});

test('confere versao do Minecraft e loader e avisa sobre metadados ilegíveis', async () => {
  const meta = await lerMetadadosBuffer(jar({ id: 'exigente', depends: { minecraft: '>=1.21.2', fabricloader: '>=0.17' } }));
  assert.equal(auditarPack([registro('Exigente', meta)], alvo).bloqueios.length, 2);
  const r = auditarPack([registro('Privado', null)], alvo);
  assert.equal(r.status, 'incompleto'); assert.equal(r.bloqueios.length, 0);
  assert.equal(javaDoMinecraft('1.20.1'), 17); assert.equal(javaDoMinecraft('1.21.1'), 21); assert.equal(javaDoMinecraft('26.1'), 25);
});

test('biblioteca original sem loja satisfaz adicional sem download duplicado', async (t) => {
  limparCache();
  const buf = jar({ id: 'adicional', depends: { privado: '>=2.0.0' } });
  const v = { id: 'versao-adicional', project_id: 'adicional', version_number: '1.0.0', version_type: 'release', date_published: '2026-01-01', game_versions: ['1.21.1'], loaders: ['fabric'], dependencies: [], files: [{ filename: 'adicional.jar', url: 'https://exemplo.test/adicional.jar', size: buf.length, hashes: { sha1: '1'.repeat(40) } }] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('adicional.jar')) return new Response(buf, { headers: { 'content-length': String(buf.length) } });
    if (String(url).includes('/project/adicional/version')) return Response.json([v]);
    if (String(url).includes('/projects?')) return Response.json([{ id: 'adicional', title: 'Adicional', slug: 'adicional', client_side: 'required', server_side: 'required' }]);
    throw new Error(`Chamada inesperada: ${url}`);
  });
  const meta = await lerMetadadosBuffer(jar({ id: 'privado', version: '2.0.0' }));
  const p = await resolver({ ...alvo, itens: [{ fonte: 'modrinth', projetoId: 'adicional' }], contexto: [registro('Privado original', meta, { fonte: 'original', origem: 'original', arquivo: { nome: 'privado.jar' } })] });
  assert.equal(p.resumo.bloqueios, 0); assert.deepEqual(p.arquivos.map((r) => r.projetoId), ['adicional']);
  assert.equal(p.adicionadosPorMetadados.length, 0);
});

test('ajuste preserva versao explicitamente fixada', async () => {
  const a = registro('Escolhido', await lerMetadadosBuffer(jar({ id: 'escolhido', version: '1.0.0' })), { fonte: 'modrinth', projetoId: 'escolhido', fixado: true });
  const b = registro('Original', await lerMetadadosBuffer(jar({ id: 'original', depends: { escolhido: '>=2.0.0' } })), { origem: 'original', fixado: true });
  const r = await ajustar({ registros: [a, b], alvo, listarVersoes: () => { throw new Error('Nao deve trocar versao fixada'); }, acharPorModId: () => null });
  assert.equal(r.trocas.length, 0); assert.ok(r.problemas.some((p) => p.tipo === 'versao-incompativel'));
});

test('busca uma dependencia na CurseForge quando nao existe na Modrinth', async (t) => {
  limparCache();
  const chaveAnterior = process.env.CURSEFORGE_API_KEY;
  process.env.CURSEFORGE_API_KEY = 'chave-ficticia-do-teste';
  t.after(() => { if (chaveAnterior === undefined) delete process.env.CURSEFORGE_API_KEY; else process.env.CURSEFORGE_API_KEY = chaveAnterior; });
  const principal = jar({ id: 'usa_cf', depends: { biblioteca_cf: '>=2.0.0' } });
  const biblioteca = jar({ id: 'biblioteca_cf', version: '2.0.0' });
  const projetoCf = { id: 12345, name: 'Biblioteca privada CF', slug: 'biblioteca-cf', allowModDistribution: true };
  const versaoCf = { id: 54321, modId: 12345, displayName: 'Biblioteca 2.0.0', fileName: 'biblioteca-cf.jar', downloadUrl: 'https://exemplo.test/biblioteca-cf.jar', fileLength: biblioteca.length, fileDate: '2026-01-01', gameVersions: ['1.21.1', 'Fabric'], releaseType: 1, hashes: [{ algo: 1, value: '2'.repeat(40) }] };
  const v = { id: 'version-usa-cf', project_id: 'usa-cf', version_number: '1.0.0', version_type: 'release', date_published: '2026-01-01', game_versions: ['1.21.1'], loaders: ['fabric'], dependencies: [], files: [{ filename: 'usa-cf.jar', url: 'https://exemplo.test/usa-cf.jar', size: principal.length, hashes: { sha1: '3'.repeat(40) } }] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    url = String(url);
    if (url.endsWith('usa-cf.jar')) return new Response(principal, { headers: { 'content-length': String(principal.length) } });
    if (url.endsWith('biblioteca-cf.jar')) return new Response(biblioteca, { headers: { 'content-length': String(biblioteca.length) } });
    if (url.includes('/project/usa-cf/version')) return Response.json([v]);
    if (url.includes('api.modrinth.com/v2/projects?')) return Response.json([{ id: 'usa-cf', title: 'Usa CF', slug: 'usa-cf' }]);
    if (url.includes('api.modrinth.com/v2/search')) return Response.json({ hits: [], total_hits: 0 });
    if (url.includes('api.modrinth.com/v2/project/')) return new Response('', { status: 404 });
    if (url.includes('/mods/search?')) return Response.json({ data: [projetoCf] });
    if (url.includes('/mods/12345/files?')) return Response.json({ data: [versaoCf] });
    if (url.endsWith('/mods/12345')) return Response.json({ data: projetoCf });
    throw new Error(`Chamada inesperada: ${url}`);
  });
  const p = await resolver({ ...alvo, itens: [{ fonte: 'modrinth', projetoId: 'usa-cf' }] });
  assert.equal(p.resumo.bloqueios, 0); assert.equal(p.erros.length, 0);
  assert.ok(p.arquivos.some((m) => m.fonte === 'curseforge' && m.modId === 'biblioteca_cf'));
});

test('dependencia com cadastro removido mas embutida nao vira incompatibilidade', async (t) => {
  limparCache();
  const buf = jar({ id: 'cadastro_removido', jars: [{ file: 'lib.jar' }], depends: { lib_embutida: '*' } }, [{ caminho: 'lib.jar', dados: jar({ id: 'lib_embutida' }) }]);
  const v = { id: 'versao-cadastro-removido', project_id: 'cadastro-removido', version_number: '1.0.0', version_type: 'release', date_published: '2026-01-01', game_versions: ['1.21.1'], loaders: ['fabric'], dependencies: [{ project_id: 'apagado', dependency_type: 'required' }], files: [{ filename: 'cadastro-removido.jar', url: 'https://exemplo.test/cadastro-removido.jar', size: buf.length, hashes: { sha1: '4'.repeat(40) } }] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    url = String(url);
    if (url.endsWith('cadastro-removido.jar')) return new Response(buf, { headers: { 'content-length': String(buf.length) } });
    if (url.includes('/project/cadastro-removido/version')) return Response.json([v]);
    if (url.includes('/project/apagado/version')) return new Response('', { status: 404 });
    if (url.includes('/projects?')) return Response.json([{ id: 'cadastro-removido', title: 'Cadastro removido', slug: 'cadastro-removido' }]);
    throw new Error(`Chamada inesperada: ${url}`);
  });
  const p = await resolver({ ...alvo, itens: [{ fonte: 'modrinth', projetoId: 'cadastro-removido' }] });
  assert.equal(p.resumo.bloqueios, 0); assert.equal(p.erros.length, 0); assert.equal(p.faltando.length, 0);
  assert.ok(p.conflitos.some((c) => c.grupo === 'catalogo-indisponivel' && c.severidade === 'aviso'));
});
