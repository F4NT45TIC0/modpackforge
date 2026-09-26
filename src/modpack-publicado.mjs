import { readFile } from 'node:fs/promises';
import * as modrinth from './modrinth.mjs';
import { planoDeInstalacaoServidor } from './loaders.mjs';
import { gerarSlug } from './exportar.mjs';
import { lerDiretorioZipRemoto, lerArquivoZipRemoto } from './ler-zip-remoto.mjs';
import { checarCandidato } from '../web/compartilhado/conflitos.mjs';
import { lerMetadados, lerMetadadosBuffer } from './jarmeta.mjs';
import { auditarPack, exigirServidorValido, selecionarModsServidor } from './auditoria.mjs';
import { criarVerificador, textoVerificacao } from './verificador-servidor.mjs';

const MOLDE = new URL('./instalador-modpack.sh', import.meta.url);
const DEPENDENCIAS = [
  ['fabric-loader', 'fabric'], ['quilt-loader', 'quilt'],
  ['forge', 'forge'], ['neoforge', 'neoforge'],
];

const aspas = (valor) => `'${String(valor).replace(/'/g, "'\\''")}'`;

export function modsEmbutidos(entradas) {
  return [...entradas.keys()].filter((nome) =>
    /^(overrides|client-overrides|server-overrides)\/mods\/.+\.jar$/i.test(nome));
}

function caminhoSeguro(valor, { paraUnzip = false } = {}) {
  const p = String(valor ?? '');
  const invalidos = paraUnzip ? /[\\|*?\[\]\x00-\x1f]/ : /[\\|\x00-\x1f]/;
  return p.length > 0 && p.length <= 240 && !invalidos.test(p) &&
    !p.startsWith('/') && p.split('/').every((parte) => parte && parte !== '.' && parte !== '..');
}

function urlSegura(valor) {
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && !url.username && !url.password && !/[|\r\n]/.test(valor);
  } catch { return false; }
}

/** Lê só o índice e o diretório ZIP, mesmo quando o .mrpack tem centenas de MB. */
export async function lerModpackPublicado(projetoId, versaoId) {
  const [projeto, versao] = await Promise.all([
    modrinth.projeto(projetoId), modrinth.versaoPorId(versaoId),
  ]);
  if (projeto.tipo !== 'modpack' || versao.projetoId !== projeto.id) throw new Error('Versão não pertence a este modpack.');
  if (!versao.arquivo?.nome?.toLowerCase().endsWith('.mrpack')) throw new Error('Esta versão não tem arquivo .mrpack.');
  if (!/^[^\\/\x00-\x1f]{1,180}$/.test(versao.arquivo.nome)) throw new Error('Nome do .mrpack inválido.');
  if (!/^[a-f0-9]{40}$/i.test(versao.arquivo.sha1 ?? '')) throw new Error('O .mrpack não tem SHA-1 publicado.');
  const alvo = new URL(versao.arquivo.url);
  if (alvo.protocol !== 'https:' || alvo.hostname !== 'cdn.modrinth.com') throw new Error('Endereço de download do modpack inesperado.');
  const entradas = await lerDiretorioZipRemoto(versao.arquivo.url);
  const indice = JSON.parse((await lerArquivoZipRemoto(versao.arquivo.url, entradas.get('modrinth.index.json'))).toString('utf8'));
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
  const usados = new Set();
  for (const item of indice.files) {
    if (!caminhoSeguro(item.path) || usados.has(item.path)) throw new Error('O .mrpack contém caminho inválido ou duplicado.');
    usados.add(item.path);
    const url = item.downloads?.find(urlSegura);
    const sha1 = String(item.hashes?.sha1 ?? '').toLowerCase();
    if (!url || !/^[a-f0-9]{40}$/.test(sha1)) throw new Error(`Download ou SHA-1 inválido: ${item.path}`);
    const partes = new URL(url).hostname === 'cdn.modrinth.com'
      ? new URL(url).pathname.match(/^\/data\/([\w-]{8})\/versions\/([\w-]{8})\//) : null;
    arquivos.push({ caminho: item.path, sha1, url, env: item.env, projetoId: partes?.[1] ?? null, versaoId: partes?.[2] ?? null });
  }
  return { projeto, versao, indice, entradas, arquivos, mc, loader, loaderVersao };
}

/** Os JARs originais sao contexto de dependencias, mesmo sem cadastro em loja. */
export async function registrosDoModpack(base, removidos = []) {
  const remover = new Set(removidos);
  const projetos = await modrinth.projetosEmLote(base.arquivos.map((a) => a.projetoId)).catch(() => []);
  const porId = new Map(projetos.map((p) => [p.id, p]));
  const registros = await Promise.all(base.arquivos.filter((a) => a.caminho.startsWith('mods/') && /\.jar$/i.test(a.caminho) && !remover.has(a.caminho)).map(async (a) => {
    const p = porId.get(a.projetoId);
    return {
      chave: a.projetoId ? `modrinth:${a.projetoId}` : `original:${a.caminho}`, fonte: a.projetoId ? 'modrinth' : 'original',
      projetoId: a.projetoId, versaoId: a.versaoId, nome: p?.nome ?? a.caminho.split('/').at(-1), slug: p?.slug,
      caminho: a.caminho, tipo: 'mod', ladoServidor: a.env?.server === 'unsupported' ? 'unsupported' : p?.ladoServidor,
      ladoCliente: a.env?.client === 'unsupported' ? 'unsupported' : p?.ladoCliente,
      arquivo: { nome: a.caminho.split('/').at(-1), url: a.url, sha1: a.sha1, tamanho: base.indice.files.find((f) => f.path === a.caminho)?.fileSize ?? 0 },
      meta: await lerMetadados(a.url, base.indice.files.find((f) => f.path === a.caminho)?.fileSize, base.loader, { publico: true }),
      distribuicaoLiberada: true, origem: 'original', fixado: true, exigidoPor: [],
    };
  }));
  // O override de servidor prevalece sobre o comum para o mesmo caminho.
  const overrides = modsEmbutidos(base.entradas).filter((c) => !remover.has(c));
  for (const caminho of overrides) {
    let meta = null;
    try {
      const buf = await lerArquivoZipRemoto(base.versao.arquivo.url, base.entradas.get(caminho), 32 * 1024 * 1024);
      meta = await lerMetadadosBuffer(buf, base.loader);
    } catch { /* A auditoria relata a leitura incompleta. */ }
    registros.push({ chave: `original:${caminho}`, fonte: 'original', nome: caminho.split('/').at(-1), caminho,
      tipo: 'mod', ladoServidor: caminho.startsWith('client-overrides/') ? 'unsupported' : 'unknown',
      ladoCliente: caminho.startsWith('server-overrides/') ? 'unsupported' : 'unknown',
      arquivo: { nome: caminho.split('/').at(-1) }, meta, origem: 'original', fixado: true, distribuicaoLiberada: true, exigidoPor: [] });
  }
  return registros;
}

export function registrosDoCliente(registros) {
  const porCaminho = new Map();
  for (const r of registros) {
    if (r.caminho.startsWith('server-overrides/') || r.ladoCliente === 'unsupported' || r.meta?.ambiente === 'server') continue;
    porCaminho.set(r.caminho.replace(/^(overrides|client-overrides)\//, ''), r);
  }
  return [...porCaminho.values()];
}

export function registrosDoServidor(registros) {
  const porCaminho = new Map();
  for (const r of registros) {
    if (r.caminho.startsWith('client-overrides/')) continue;
    porCaminho.set(r.caminho.replace(/^(overrides|server-overrides)\//, ''), r);
  }
  return selecionarModsServidor([...porCaminho.values()]).servidor;
}

/** Gera um .sh com os arquivos do servidor, preservando os overrides originais. */
export async function prepararModpackPublicado(projetoId, versaoId, {
  memoriaMb = 4096, porta = 25565, removidos = [], acrescidos = [], nome: nomeEditado = null,
  base: baseLida = null, gerarServidor = true,
} = {}) {
  const base = baseLida ?? await lerModpackPublicado(projetoId, versaoId);
  const { projeto, versao, indice, entradas, mc, loader, loaderVersao } = base;
  const remover = new Set(removidos);
  const embutidos = new Set(modsEmbutidos(entradas));
  if ([...remover].some((caminho) => !embutidos.has(caminho) && !base.arquivos.some((a) => a.caminho === caminho))) {
    throw new Error('A remoção contém um arquivo que não existe no modpack.');
  }
  const arquivos = base.arquivos.filter((a) => !remover.has(a.caminho));
  const usados = new Set(arquivos.map((a) => a.caminho));
  const indiceEditado = { ...indice, files: indice.files.filter((a) => !remover.has(a.path)) };
  for (const extra of acrescidos) {
    if (!caminhoSeguro(extra.path) || usados.has(extra.path) || !urlSegura(extra.downloads?.[0]) ||
        !/^[a-f0-9]{40}$/i.test(extra.hashes?.sha1 ?? '')) throw new Error(`Arquivo adicional inválido: ${extra.path}`);
    usados.add(extra.path);
    const { projetoId: projetoExtra, versaoId: versaoExtra, ...arquivoNoIndice } = extra;
    indiceEditado.files.push(arquivoNoIndice);
    arquivos.push({
      caminho: extra.path, sha1: extra.hashes.sha1.toLowerCase(), url: extra.downloads[0],
      env: extra.env, projetoId: projetoExtra ?? null, versaoId: versaoExtra ?? null,
    });
  }
  const excluidos = [];
  const baseEditada = { ...base, indice: indiceEditado, arquivos };
  const registros = await registrosDoModpack(baseEditada, removidos);
  const servidor = registrosDoServidor(registros);
  const verificacao = auditarPack(servidor, { lado: 'server', mc, loader, loaderVersao });
  if (gerarServidor) exigirServidorValido(verificacao);

  // Alguns autores marcam todos os arquivos como necessários no servidor, até
  // Sodium e Iris. Conferimos os projetos e versões de cada mod hospedado na
  // Modrinth antes de aceitar esse rótulo.
  const [projetos, versoes] = await Promise.all([
    modrinth.projetosEmLote(arquivos.map((a) => a.projetoId)),
    modrinth.versoesEmLote(arquivos.map((a) => a.versaoId)),
  ]);
  const projetosPorId = new Map(projetos.map((p) => [p.id, p]));
  const versoesPorId = new Map(versoes.map((v) => [v.id, v]));
  if (acrescidos.length) {
    const originais = base.arquivos.filter((a) => !remover.has(a.caminho) && a.caminho.startsWith('mods/') && a.projetoId);
    for (const extra of acrescidos.filter((a) => a.path.startsWith('mods/') && a.projetoId)) {
      const projetoExtra = projetosPorId.get(extra.projetoId);
      const versaoExtra = versoesPorId.get(extra.versaoId);
      if (!projetoExtra) continue;
      const candidato = { ...projetoExtra, id: extra.projetoId };
      for (const original of originais) {
        const projetoOriginal = projetosPorId.get(original.projetoId);
        const versaoOriginal = versoesPorId.get(original.versaoId);
        if (!projetoOriginal) continue;
        const incompatibilidade = versaoExtra?.dependencies?.some((d) => d.dependency_type === 'incompatible' && d.project_id === original.projetoId) ||
          versaoOriginal?.dependencies?.some((d) => d.dependency_type === 'incompatible' && d.project_id === extra.projetoId);
        const conhecido = checarCandidato(candidato, [{ ...projetoOriginal, projetoId: original.projetoId }])
          .some((c) => c.severidade === 'bloqueio');
        if (incompatibilidade || conhecido) {
          throw Object.assign(new Error(`${projetoExtra.nome} conflita com ${projetoOriginal.nome} do modpack original.`), { status: 409 });
        }
      }
    }
  }
  const candidatos = new Set(arquivos.filter((a) => {
    const versao = versoesPorId.get(a.versaoId);
    if (a.caminho.startsWith('mods/')) return servidor.some((r) => r.caminho === a.caminho);
    return !['eula.txt', 'run.sh', 'iniciar.sh', 'server.jar'].includes(a.caminho) &&
      !['shaderpacks/', 'resourcepacks/'].some((prefixo) => a.caminho.startsWith(prefixo)) &&
      a.env?.server !== 'unsupported' &&
      !['client_only', 'singleplayer_only'].includes(versao?.environment);
  }));
  const arquivosServidor = arquivos.filter((a) => candidatos.has(a));
  excluidos.push(...arquivos.filter((a) => !candidatos.has(a)).map((a) => a.caminho));

  const overrides = [];
  let tamanhoOverrides = 0;
  for (const prefixo of ['overrides/', 'server-overrides/']) {
    for (const [origem, entrada] of entradas) {
      if (!origem.startsWith(prefixo) || origem.endsWith('/') || remover.has(origem)) continue;
      const destino = origem.slice(prefixo.length);
      if (destino.startsWith('mods/') && !servidor.some((r) => r.caminho === origem)) {
        excluidos.push(origem);
        continue;
      }
      if (!caminhoSeguro(destino, { paraUnzip: true }) || ![0, 8].includes(entrada.metodo)) throw new Error('O .mrpack contém override inválido.');
      if (['eula.txt', 'run.sh', 'iniciar.sh', 'server.jar'].includes(destino)) continue;
      if (['resourcepacks/', 'shaderpacks/', 'config/yosbr/'].some((p) => destino.startsWith(p)) ||
          ['options.txt', 'config/iris.properties', 'config/oculus.properties'].includes(destino)) continue;
      tamanhoOverrides += entrada.descomprimido;
      if (entrada.descomprimido > 1024 * 1024 * 1024 || tamanhoOverrides > 2 * 1024 * 1024 * 1024) {
        throw new Error('Os overrides deste .mrpack são grandes demais para o instalador.');
      }
      overrides.push({ origem, destino });
    }
  }

  const instalador = await planoDeInstalacaoServidor(loader, mc, loaderVersao);
  const nome = String(nomeEditado || indice.name || projeto.nome).replace(/[\x00-\x1f]+/g, ' ').slice(0, 80);
  indiceEditado.name = nome;
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
    JAVA_MINIMO: String(verificacao.javaMinimo),
    JAVA_PERMITIDOS: verificacao.javaPermitidos.join(' '),
    VERIFICACAO: textoVerificacao(verificacao),
    VERIFICADOR: criarVerificador(),
  };
  let script = await readFile(MOLDE, 'utf8');
  for (const [chave, valor] of Object.entries(valores)) script = script.split(`@@${chave}@@`).join(valor);
  return {
    projeto, versao, indice: indiceEditado,
    removidosEmbutidos: [...remover].filter((caminho) => embutidos.has(caminho)),
    nomeArquivo: `instalar-servidor-${gerarSlug(nome)}.sh`,
    script: Buffer.from(script.replace(/\r\n/g, '\n'), 'utf8'),
    resumo: { nome, mc, loader, loaderVersao, arquivos: arquivosServidor.length, excluidos: excluidos.length, overrides: overrides.length, verificacao },
  };
}
