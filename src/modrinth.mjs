// Provider da Modrinth (API v2, pública, sem chave).
// Tudo que sai daqui já está no formato comum descrito em resolver.mjs.

import { pedirJson, TTL } from './http.mjs';
import { loadersAceitos } from './loaders.mjs';

const BASE = 'https://api.modrinth.com/v2';
const facetas = (v) => encodeURIComponent(JSON.stringify(v));

export const CATEGORIAS = [
  { id: 'optimization', nome: 'Desempenho' },
  { id: 'technology', nome: 'Tecnologia' },
  { id: 'magic', nome: 'Magia' },
  { id: 'adventure', nome: 'Aventura' },
  { id: 'worldgen', nome: 'Mundo' },
  { id: 'mobs', nome: 'Criaturas' },
  { id: 'equipment', nome: 'Equipamento' },
  { id: 'storage', nome: 'Armazenamento' },
  { id: 'decoration', nome: 'Decoração' },
  { id: 'food', nome: 'Comida' },
  { id: 'utility', nome: 'Utilidades' },
  { id: 'library', nome: 'Bibliotecas' },
];

// Para shaders, o filtro que importa é "isso roda no PC de quem vai jogar?".
// A Modrinth marca o impacto no desempenho; um shader com vários perfis traz
// várias marcas (o Complementary tem de "potato" a "high").
export const CATEGORIAS_SHADER = [
  { id: 'potato', nome: 'PC fraco' },
  { id: 'low', nome: 'Leve' },
  { id: 'medium', nome: 'Médio' },
  { id: 'high', nome: 'Pesado' },
  { id: 'realistic', nome: 'Realista' },
  { id: 'semi-realistic', nome: 'Semi-realista' },
  { id: 'fantasy', nome: 'Fantasia' },
  { id: 'cartoon', nome: 'Cartoon' },
  { id: 'vanilla-like', nome: 'Estilo vanilla' },
];

export const CATEGORIAS_MODPACK = [
  { id: 'adventure', nome: 'Aventura' },
  { id: 'technology', nome: 'Tecnologia' },
  { id: 'magic', nome: 'Magia' },
  { id: 'optimization', nome: 'Desempenho' },
  { id: 'kitchen-sink', nome: 'Variado' },
  { id: 'quests', nome: 'Missões' },
];

export const CATEGORIAS_RECURSO = [
  { id: 'realistic', nome: 'Realista' },
  { id: 'simplistic', nome: 'Simples' },
  { id: 'themed', nome: 'Temático' },
  { id: 'vanilla-like', nome: 'Estilo vanilla' },
  { id: '16x', nome: '16x' },
  { id: '32x', nome: '32x' },
  { id: '64x', nome: '64x' },
];

// Marcas de plataforma que não interessam na lista de categorias de um projeto.
const MARCAS_DE_PLATAFORMA = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'iris', 'optifine', 'canvas', 'vanilla']);

// Um shader serve se a versão declara Iris ou OptiFine: o Iris (e o Oculus, a
// versão dele para Forge) roda a imensa maioria dos shaders feitos para OptiFine.
const CARREGADORES_DE_SHADER = ['iris', 'optifine'];

function normalizarProjeto(p) {
  const tipo = ['mod', 'shader', 'modpack', 'resourcepack'].includes(p.project_type) ? p.project_type : 'mod';
  return {
    fonte: 'modrinth',
    tipo,
    id: p.project_id ?? p.id,
    slug: p.slug,
    nome: p.title,
    resumo: p.description ?? '',
    autor: p.author ?? p.organization ?? null,
    downloads: p.downloads ?? 0,
    seguidores: p.follows ?? 0,
    icone: p.icon_url ?? null,
    categorias: (p.categories ?? []).filter((c) => !MARCAS_DE_PLATAFORMA.has(c)),
    pagina: `https://modrinth.com/${tipo}/${p.slug}`,
    ladoCliente: p.client_side ?? 'unknown',
    ladoServidor: p.server_side ?? 'unknown',
    atualizado: p.date_modified ?? p.updated ?? null,
    distribuicaoLiberada: true, // a Modrinth só hospeda o que pode ser redistribuído
  };
}

function normalizarVersao(v) {
  const arquivo = v.files.find((f) => f.primary) ?? v.files[0];
  return {
    fonte: 'modrinth',
    id: v.id,
    projetoId: v.project_id,
    nome: v.name,
    numero: v.version_number,
    canal: v.version_type, // release | beta | alpha
    publicado: v.date_published,
    downloads: v.downloads ?? 0,
    versoesJogo: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    arquivo: arquivo && {
      nome: arquivo.filename,
      url: arquivo.url,
      tamanho: arquivo.size,
      sha1: arquivo.hashes?.sha1 ?? null,
      sha512: arquivo.hashes?.sha512 ?? null,
    },
    dependencias: (v.dependencies ?? []).map((d) => ({
      fonte: 'modrinth',
      projetoId: d.project_id,
      versaoId: d.version_id,
      tipo: d.dependency_type, // required | optional | incompatible | embedded
    })),
    distribuicaoLiberada: true,
  };
}

export async function buscar({
  consulta = '',
  loader,
  mc,
  categorias = [],
  ordem = 'relevance',
  deslocamento = 0,
  limite = 20,
  tipo = 'mod',
}) {
  const filtros = [];
  if (tipo === 'shader') {
    // Shader não depende do loader nem, na prática, da versão do jogo: o que
    // decide é rodar no Iris. Filtrar pela versão esconderia shaders que
    // funcionam mas cujo autor não marcou a versão mais nova.
    filtros.push(['project_type:shader'], CARREGADORES_DE_SHADER.map((c) => `categories:${c}`));
  } else {
    filtros.push([`project_type:${tipo}`]);
    if (mc) filtros.push([`versions:${mc}`]);
    if (loader && ['mod', 'modpack'].includes(tipo)) filtros.push(loadersAceitos(loader).map((l) => `categories:${l}`));
  }
  for (const c of categorias) filtros.push([`categories:${c}`]);

  const url =
    `${BASE}/search?query=${encodeURIComponent(consulta)}` +
    `&facets=${facetas(filtros)}&index=${encodeURIComponent(ordem)}` +
    `&offset=${deslocamento}&limit=${limite}`;

  const dados = await pedirJson(url, { ttl: TTL.curto });
  return {
    total: dados.total_hits ?? 0,
    itens: (dados.hits ?? []).map(normalizarProjeto),
  };
}

export async function projeto(idOuSlug) {
  const p = await pedirJson(`${BASE}/project/${encodeURIComponent(idOuSlug)}`, { ttl: TTL.medio });
  return { ...normalizarProjeto(p), corpo: p.body ?? '' };
}

/** Busca vários projetos de uma vez — usado para nomear dependências resolvidas. */
export async function projetosEmLote(ids) {
  const unicos = [...new Set(ids)].filter(Boolean);
  if (!unicos.length) return [];
  const saida = [];
  for (let i = 0; i < unicos.length; i += 60) {
    const lote = unicos.slice(i, i + 60);
    const dados = await pedirJson(
      `${BASE}/projects?ids=${encodeURIComponent(JSON.stringify(lote))}`,
      { ttl: TTL.medio },
    );
    saida.push(...dados.map(normalizarProjeto));
  }
  return saida;
}

/** Versões de um mod compatíveis com o loader e a versão do jogo escolhidos. */
export async function versoes(projetoId, { loader, mc } = {}) {
  const params = [];
  if (loader) params.push(`loaders=${encodeURIComponent(JSON.stringify(loadersAceitos(loader)))}`);
  if (mc) params.push(`game_versions=${encodeURIComponent(JSON.stringify([mc]))}`);
  const url = `${BASE}/project/${encodeURIComponent(projetoId)}/version${params.length ? '?' + params.join('&') : ''}`;
  const dados = await pedirJson(url, { ttl: TTL.medio });
  return dados.map(normalizarVersao).filter((v) => v.arquivo);
}

/** Versões de um shader que rodam no Iris, das mais novas às mais antigas. */
export async function versoesShader(projetoId) {
  const url =
    `${BASE}/project/${encodeURIComponent(projetoId)}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify(CARREGADORES_DE_SHADER))}`;
  const dados = await pedirJson(url, { ttl: TTL.medio });
  return dados.map(normalizarVersao).filter((v) => v.arquivo);
}

export async function versoesRecurso(projetoId, mc) {
  const url = `${BASE}/project/${encodeURIComponent(projetoId)}/version?game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;
  const dados = await pedirJson(url, { ttl: TTL.medio });
  return dados.map(normalizarVersao).filter((v) => v.arquivo);
}

/**
 * A versão de shader a instalar: de preferência uma que o autor marcou para
 * esta versão do jogo, depois qualquer uma — shaders raramente quebram entre
 * versões do Minecraft, e muitos autores esquecem de marcar as novas.
 */
export function melhorVersaoShader(lista, mc) {
  if (!lista.length) return null;
  const ordenar = (vs) => [...vs].sort((a, b) => new Date(b.publicado) - new Date(a.publicado));
  const preferir = (vs) => vs.find((v) => v.canal === 'release') ?? vs[0];
  const marcadas = ordenar(lista.filter((v) => v.versoesJogo.includes(mc)));
  return marcadas.length ? preferir(marcadas) : preferir(ordenar(lista));
}

export async function versaoPorId(versaoId) {
  const v = await pedirJson(`${BASE}/version/${encodeURIComponent(versaoId)}`, { ttl: TTL.medio });
  return normalizarVersao(v);
}

/** Metadados das versões incluídas num .mrpack, para conferir o lado servidor. */
export async function versoesEmLote(ids) {
  const unicos = [...new Set(ids)].filter(Boolean);
  const saida = [];
  for (let i = 0; i < unicos.length; i += 60) {
    const lote = unicos.slice(i, i + 60);
    const dados = await pedirJson(`${BASE}/versions?ids=${encodeURIComponent(JSON.stringify(lote))}`, { ttl: TTL.medio });
    saida.push(...dados);
  }
  return saida;
}

/** A mais nova entre as compatíveis, preferindo release a beta/alpha. */
export function melhorVersao(lista) {
  if (!lista.length) return null;
  const porData = [...lista].sort((a, b) => new Date(b.publicado) - new Date(a.publicado));
  return porData.find((v) => v.canal === 'release') ?? porData[0];
}
