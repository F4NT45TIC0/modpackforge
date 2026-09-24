// Provider da CurseForge (API v1). Exige uma chave gratuita de console.curseforge.com.
// Sem chave o app continua funcionando, só que apenas com a Modrinth.

import { pedirJson, ErroHttp, TTL } from './http.mjs';
import { lerConfig } from './store.mjs';

const BASE = 'https://api.curseforge.com/v1';
const JOGO_MINECRAFT = 432;
const CLASSE_MODS = 6;

const LOADER_PARA_CODIGO = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

const RELACAO = { 1: 'embedded', 2: 'optional', 3: 'required', 4: 'tool', 5: 'incompatible', 6: 'embedded' };
const CANAL = { 1: 'release', 2: 'beta', 3: 'alpha' };

export class SemChaveCurseforge extends Error {
  constructor() {
    super('A CurseForge precisa de uma chave de API para responder.');
    this.name = 'SemChaveCurseforge';
    this.codigo = 'CF_SEM_CHAVE';
  }
}

// Uma chave aceita hoje pode ser revogada amanhã. Quando a CurseForge recusa,
// paramos de chamá-la até a chave ser trocada — senão toda tecla digitada na
// busca dispara uma requisição que já sabemos que vai falhar.
let chaveReprovada = false;

export const chaveFoiReprovada = () => chaveReprovada;
export const esquecerReprovacao = () => { chaveReprovada = false; };

/**
 * De onde vem a chave.
 *
 * A variável de ambiente CURSEFORGE_API_KEY vence: é assim que funciona quando o
 * app roda como site (na Vercel não há disco onde guardar configuração, e num
 * site público quem define a chave é quem hospeda, não o visitante). No PC, sem a
 * variável, vale a chave salva pela tela de Configurações.
 */
export const chaveVemDoAmbiente = () => Boolean(process.env.CURSEFORGE_API_KEY?.trim());

async function chaveAtual() {
  const doAmbiente = process.env.CURSEFORGE_API_KEY?.trim();
  if (doAmbiente) return doAmbiente;
  const { chaveCurseforge } = await lerConfig();
  return chaveCurseforge?.trim() || '';
}

export async function temChave() {
  if (chaveReprovada) return false;
  return Boolean(await chaveAtual());
}

/** Existe chave configurada, mesmo que ela esteja sendo recusada agora. */
export async function chaveGravada() {
  return Boolean(await chaveAtual());
}

/** Os últimos caracteres da chave, para a tela mostrar qual está em uso. */
export async function finalDaChave() {
  const chave = await chaveAtual();
  return chave ? `...${chave.slice(-6)}` : null;
}

async function chamar(caminho, opcoes = {}) {
  const chave = await chaveAtual();
  if (!chave) throw new SemChaveCurseforge();
  try {
    return await pedirJson(BASE + caminho, {
      ...opcoes,
      headers: { 'x-api-key': chave, ...(opcoes.headers ?? {}) },
    });
  } catch (erro) {
    if (erro instanceof ErroHttp && (erro.status === 401 || erro.status === 403)) {
      chaveReprovada = true;
      const e = new Error('A CurseForge recusou a chave de API.');
      e.codigo = 'CF_CHAVE_INVALIDA';
      throw e;
    }
    throw erro;
  }
}

/** Testa a chave antes de gravá-la, para o erro aparecer nas Configurações e não na busca. */
export async function validarChave(chave) {
  try {
    await pedirJson(BASE + '/games/' + JOGO_MINECRAFT, {
      headers: { 'x-api-key': chave.trim() },
      timeout: 12000,
    });
  } catch (erro) {
    if (erro instanceof ErroHttp && (erro.status === 401 || erro.status === 403)) {
      const e = new Error(
        'A CurseForge recusou esta chave. Gere uma nova em console.curseforge.com e cole de novo — chaves antigas às vezes são revogadas.',
      );
      e.codigo = 'CF_CHAVE_INVALIDA';
      throw e;
    }
    throw erro;
  }
  chaveReprovada = false;
  return true;
}

const PADRAO_VERSAO = /^\d+(\.\d+)*((-|_)(pre|rc)\d*)?$/i;
const ehVersaoDeJogo = (s) => PADRAO_VERSAO.test(s);
const NOMES_DE_LOADER = ['forge', 'fabric', 'quilt', 'neoforge'];

function normalizarMod(m) {
  return {
    fonte: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    nome: m.name,
    resumo: m.summary ?? '',
    autor: m.authors?.[0]?.name ?? null,
    downloads: m.downloadCount ?? 0,
    seguidores: m.thumbsUpCount ?? 0,
    icone: m.logo?.thumbnailUrl ?? m.logo?.url ?? null,
    categorias: (m.categories ?? []).map((c) => c.slug).filter(Boolean),
    pagina: m.links?.websiteUrl ?? 'https://www.curseforge.com/minecraft/mc-mods/' + m.slug,
    ladoCliente: 'unknown',
    ladoServidor: 'unknown',
    atualizado: m.dateModified ?? null,
    // Quando o autor desliga a distribuição, a API devolve downloadUrl nulo e o
    // download tem que ser manual. Marcamos aqui para avisar antes de exportar.
    distribuicaoLiberada: m.allowModDistribution !== false,
  };
}

function normalizarArquivo(f, distribuicaoLiberada) {
  const sha1 = f.hashes?.find((h) => h.algo === 1)?.value ?? null;
  const marcas = (f.gameVersions ?? []).map((g) => String(g));
  return {
    fonte: 'curseforge',
    id: String(f.id),
    projetoId: String(f.modId),
    nome: f.displayName,
    numero: f.displayName,
    canal: CANAL[f.releaseType] ?? 'release',
    publicado: f.fileDate,
    downloads: f.downloadCount ?? 0,
    versoesJogo: marcas.filter(ehVersaoDeJogo),
    loaders: marcas.map((g) => g.toLowerCase()).filter((g) => NOMES_DE_LOADER.includes(g)),
    arquivo: {
      nome: f.fileName,
      url: f.downloadUrl ?? null,
      tamanho: f.fileLength ?? 0,
      sha1,
      sha512: null,
    },
    dependencias: (f.dependencies ?? [])
      .map((d) => ({
        fonte: 'curseforge',
        projetoId: String(d.modId),
        versaoId: null,
        tipo: RELACAO[d.relationType] ?? 'optional',
      }))
      .filter((d) => d.tipo !== 'tool'),
    distribuicaoLiberada: distribuicaoLiberada && Boolean(f.downloadUrl),
    paginaDoArquivo: 'https://www.curseforge.com/minecraft/mc-mods/' + f.modId + '/files/' + f.id,
  };
}

const ORDEM = { relevance: 1, downloads: 6, follows: 2, newest: 3, updated: 3 };

export async function buscar({
  consulta = '',
  loader,
  mc,
  categorias = [],
  ordem = 'relevance',
  deslocamento = 0,
  limite = 20,
}) {
  const p = new URLSearchParams({
    gameId: String(JOGO_MINECRAFT),
    classId: String(CLASSE_MODS),
    searchFilter: consulta,
    sortField: String(ORDEM[ordem] ?? 1),
    sortOrder: 'desc',
    index: String(deslocamento),
    pageSize: String(limite),
  });
  if (mc) p.set('gameVersion', mc);
  if (loader && LOADER_PARA_CODIGO[loader]) p.set('modLoaderType', String(LOADER_PARA_CODIGO[loader]));

  const dados = await chamar('/mods/search?' + p, { ttl: TTL.curto });
  return {
    total: dados.pagination?.totalCount ?? dados.data?.length ?? 0,
    itens: (dados.data ?? []).map(normalizarMod),
  };
}

export async function projeto(id) {
  const dados = await chamar('/mods/' + encodeURIComponent(id), { ttl: TTL.medio });
  return { ...normalizarMod(dados.data), corpo: '' };
}

export async function projetosEmLote(ids) {
  const unicos = [...new Set(ids.map(String))].filter(Boolean);
  if (!unicos.length) return [];
  const dados = await chamar('/mods', {
    metodo: 'POST',
    corpo: { modIds: unicos.map(Number).filter(Number.isFinite) },
    ttl: TTL.medio,
  });
  return (dados.data ?? []).map(normalizarMod);
}

export async function versoes(projetoId, { loader, mc } = {}) {
  const p = new URLSearchParams({ pageSize: '50' });
  if (mc) p.set('gameVersion', mc);
  if (loader && LOADER_PARA_CODIGO[loader]) p.set('modLoaderType', String(LOADER_PARA_CODIGO[loader]));

  const [dados, info] = await Promise.all([
    chamar('/mods/' + encodeURIComponent(projetoId) + '/files?' + p, { ttl: TTL.medio }),
    projeto(projetoId).catch(() => ({ distribuicaoLiberada: true })),
  ]);
  return (dados.data ?? [])
    .filter((f) => f.isAvailable !== false)
    .map((f) => normalizarArquivo(f, info.distribuicaoLiberada));
}

export async function versaoPorId(projetoId, arquivoId) {
  const dados = await chamar(
    '/mods/' + encodeURIComponent(projetoId) + '/files/' + encodeURIComponent(arquivoId),
    { ttl: TTL.medio },
  );
  return normalizarArquivo(dados.data, dados.data.downloadUrl != null);
}
