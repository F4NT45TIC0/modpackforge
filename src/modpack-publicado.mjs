import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as modrinth from './modrinth.mjs';
import { planoDeInstalacaoServidor } from './loaders.mjs';
import { gerarSlug } from './exportar.mjs';
import { lerEntradasZip, lerArquivoZip } from './ler-zip.mjs';
import { USER_AGENT } from './http.mjs';

const MOLDE = new URL('./instalador-modpack.sh', import.meta.url);
const LIMITE_MRPACK = 64 * 1024 * 1024;
const DEPENDENCIAS = [
  ['fabric-loader', 'fabric'], ['quilt-loader', 'quilt'],
  ['forge', 'forge'], ['neoforge', 'neoforge'],
];

const aspas = (valor) => `'${String(valor).replace(/'/g, "'\\''")}'`;

function caminhoSeguro(valor) {
  const p = String(valor ?? '');
  return p.length > 0 && p.length <= 240 && !/[\\|*?\[\]\x00-\x1f]/.test(p) &&
    !p.startsWith('/') && p.split('/').every((parte) => parte && parte !== '.' && parte !== '..');
}

function urlSegura(valor) {
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && !url.username && !url.password && !/[|\r\n]/.test(valor);
  } catch { return false; }
}

async function baixarMrpack(url, sha1) {
  const alvo = new URL(url);
  if (alvo.protocol !== 'https:' || alvo.hostname !== 'cdn.modrinth.com') throw new Error('Endereço de download do modpack inesperado.');
  const resposta = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
  if (!resposta.ok || !resposta.body) throw new Error(`Não consegui baixar o .mrpack (HTTP ${resposta.status}).`);
  const partes = [];
  let total = 0;
  for await (const parte of resposta.body) {
    total += parte.length;
    if (total > LIMITE_MRPACK) throw new Error('Este .mrpack é grande demais para converter (limite de 64 MB).');
    partes.push(parte);
  }
  const dados = Buffer.concat(partes);
  if (sha1 && createHash('sha1').update(dados).digest('hex') !== sha1.toLowerCase()) {
    throw new Error('O .mrpack baixado não confere com o hash publicado.');
  }
  return dados;
}

/** Gera um .sh usando a versão publicada e o índice oficial do .mrpack. */
export async function prepararModpackPublicado(projetoId, versaoId, { memoriaMb = 4096, porta = 25565 } = {}) {
  const [projeto, versao] = await Promise.all([
    modrinth.projeto(projetoId), modrinth.versaoPorId(versaoId),
  ]);
  if (projeto.tipo !== 'modpack' || versao.projetoId !== projeto.id) throw new Error('Versão não pertence a este modpack.');
  if (!versao.arquivo?.nome?.toLowerCase().endsWith('.mrpack')) throw new Error('Esta versão não tem arquivo .mrpack.');
  if (!/^[^\\/\x00-\x1f]{1,180}$/.test(versao.arquivo.nome)) throw new Error('Nome do .mrpack inválido.');
  if (!/^[a-f0-9]{40}$/i.test(versao.arquivo.sha1 ?? '')) throw new Error('O .mrpack não tem SHA-1 publicado.');
  const mrpack = await baixarMrpack(versao.arquivo.url, versao.arquivo.sha1);
  const entradas = lerEntradasZip(mrpack);
  const indice = JSON.parse(lerArquivoZip(mrpack, entradas.get('modrinth.index.json')).toString('utf8'));
  if (indice.formatVersion !== 1 || indice.game !== 'minecraft' || !Array.isArray(indice.files)) {
    throw new Error('Índice do .mrpack inválido ou não suportado.');
  }
  const mc = String(indice.dependencies?.minecraft ?? '');
  if (!/^[\w.\-+]{1,32}$/.test(mc)) throw new Error('Versão do Minecraft ausente no .mrpack.');
  const loaders = DEPENDENCIAS.filter(([chave]) => indice.dependencies?.[chave]);
  if (loaders.length !== 1) throw new Error('O .mrpack precisa declarar exatamente um modloader de servidor.');
  const [chaveLoader, loader] = loaders[0];
  const loaderVersao = String(indice.dependencies[chaveLoader]);
  if (!/^[\w.\-+]{1,64}$/.test(loaderVersao)) throw new Error('Versão do modloader inválida.');
  if (indice.files.length > 1500) throw new Error('O .mrpack tem arquivos demais.');

  const arquivos = [];
  const excluidos = [];
  const usados = new Set();
  for (const item of indice.files) {
    if (!caminhoSeguro(item.path) || usados.has(item.path)) throw new Error('O .mrpack contém caminho inválido ou duplicado.');
    usados.add(item.path);
    if (['eula.txt', 'run.sh', 'iniciar.sh', 'server.jar'].includes(item.path)) continue;
    const url = item.downloads?.find(urlSegura);
    const sha1 = String(item.hashes?.sha1 ?? '').toLowerCase();
    if (!url || !/^[a-f0-9]{40}$/.test(sha1)) throw new Error(`Download ou SHA-1 inválido: ${item.path}`);
    const partes = new URL(url).hostname === 'cdn.modrinth.com'
      ? new URL(url).pathname.match(/^\/data\/([\w-]{8})\/versions\/([\w-]{8})\//) : null;
    arquivos.push({ caminho: item.path, sha1, url, env: item.env, projetoId: partes?.[1] ?? null, versaoId: partes?.[2] ?? null });
  }

  // Alguns autores marcam todos os arquivos como necessários no servidor, até
  // Sodium e Iris. Conferimos os projetos e versões de cada mod hospedado na
  // Modrinth antes de aceitar esse rótulo.
  const [projetos, versoes] = await Promise.all([
    modrinth.projetosEmLote(arquivos.map((a) => a.projetoId)),
    modrinth.versoesEmLote(arquivos.map((a) => a.versaoId)),
  ]);
  const projetosPorId = new Map(projetos.map((p) => [p.id, p]));
  const versoesPorId = new Map(versoes.map((v) => [v.id, v]));
  const candidatos = new Set(arquivos.filter((a) => {
    const projeto = projetosPorId.get(a.projetoId);
    const versao = versoesPorId.get(a.versaoId);
    return !['shaderpacks/', 'resourcepacks/'].some((prefixo) => a.caminho.startsWith(prefixo)) &&
      a.env?.server !== 'unsupported' && projeto?.ladoServidor !== 'unsupported' &&
      !['client_only', 'singleplayer_only'].includes(versao?.environment);
  }));
  let mudou = true;
  while (mudou) {
    mudou = false;
    const exigidos = new Set();
    for (const a of candidatos) {
      for (const d of versoesPorId.get(a.versaoId)?.dependencies ?? []) {
        if (d.dependency_type === 'required' && d.project_id) exigidos.add(d.project_id);
      }
    }
    for (const a of arquivos) {
      if (!candidatos.has(a) && exigidos.has(a.projetoId) && a.env?.server !== 'unsupported' &&
          !['shaderpacks/', 'resourcepacks/'].some((prefixo) => a.caminho.startsWith(prefixo))) {
        candidatos.add(a);
        mudou = true;
      }
    }
  }
  const arquivosServidor = arquivos.filter((a) => candidatos.has(a));
  excluidos.push(...arquivos.filter((a) => !candidatos.has(a)).map((a) => a.caminho));

  const overrides = [];
  let tamanhoOverrides = 0;
  for (const prefixo of ['overrides/', 'server-overrides/']) {
    for (const [origem, entrada] of entradas) {
      if (!origem.startsWith(prefixo) || origem.endsWith('/')) continue;
      const destino = origem.slice(prefixo.length);
      if (!caminhoSeguro(destino) || ![0, 8].includes(entrada.metodo)) throw new Error('O .mrpack contém override inválido.');
      if (['eula.txt', 'run.sh', 'iniciar.sh', 'server.jar'].includes(destino)) continue;
      if (['resourcepacks/', 'shaderpacks/', 'config/yosbr/'].some((p) => destino.startsWith(p)) ||
          ['options.txt', 'config/iris.properties', 'config/oculus.properties'].includes(destino)) continue;
      tamanhoOverrides += entrada.descomprimido;
      if (entrada.descomprimido > 128 * 1024 * 1024 || tamanhoOverrides > 512 * 1024 * 1024) {
        throw new Error('Os overrides deste .mrpack são grandes demais para o instalador.');
      }
      overrides.push({ origem, destino });
    }
  }

  const instalador = await planoDeInstalacaoServidor(loader, mc, loaderVersao);
  const nome = String(indice.name || projeto.nome).replace(/[\x00-\x1f]+/g, ' ').slice(0, 80);
  const valores = {
    PACK_NOME: aspas(nome), PACK_SLUG: aspas(gerarSlug(nome)),
    MC_VERSAO: aspas(mc), LOADER_NOME: aspas(loader), LOADER_VERSAO: aspas(loaderVersao),
    LOADER_URL: aspas(instalador.instaladorUrl), LOADER_JAR: aspas(instalador.instaladorArquivo),
    LOADER_LANCADOR: aspas(instalador.lancador ?? ''),
    LOADER_ARGS: instalador.argumentos.map(aspas).join(' '),
    PACK_URL: aspas(versao.arquivo.url), PACK_SHA1: aspas(versao.arquivo.sha1 ?? ''),
    MEMORIA_MB: String(Math.trunc(Math.max(2048, Math.min(16384, Number(memoriaMb) || 4096)))),
    PORTA: String(Math.trunc(Math.max(1, Math.min(65535, Number(porta) || 25565)))),
    ARQUIVOS: arquivosServidor.map((a) => `  ${aspas(`${a.caminho}|${a.sha1}|${a.url}`)}`).join('\n'),
    OVERRIDES: overrides.map((a) => `  ${aspas(`${a.origem}|${a.destino}`)}`).join('\n'),
    EXCLUIDOS: excluidos.map((a) => `  ${aspas(a)}`).join('\n'),
  };
  let script = await readFile(MOLDE, 'utf8');
  for (const [chave, valor] of Object.entries(valores)) script = script.split(`@@${chave}@@`).join(valor);
  return {
    projeto, versao, mrpack,
    nomeArquivo: `instalar-servidor-${gerarSlug(nome)}.sh`,
    script: Buffer.from(script.replace(/\r\n/g, '\n'), 'utf8'),
    resumo: { nome, mc, loader, loaderVersao, arquivos: arquivosServidor.length, excluidos: excluidos.length, overrides: overrides.length },
  };
}
