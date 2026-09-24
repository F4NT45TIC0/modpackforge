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

function normalizarProjeto(p) {
  return {
    fonte: 'modrinth',
    id: p.project_id ?? p.id,
    slug: p.slug,
    nome: p.title,
    resumo: p.description ?? '',
    autor: p.author ?? p.organization ?? null,
    downloads: p.downloads ?? 0,
    seguidores: p.follows ?? 0,
    icone: p.icon_url ?? null,
    categorias: (p.categories ?? []).filter((c) => !['fabric', 'forge', 'neoforge', 'quilt'].includes(c)),
    pagina: `https://modrinth.com/mod/${p.slug}`,
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

export async function buscar({ consulta = '', loader, mc, categorias = [], ordem = 'relevance', deslocamento = 0, limite = 20 }) {
  const filtros = [['project_type:mod']];
  if (mc) filtros.push([`versions:${mc}`]);
  if (loader) filtros.push(loadersAceitos(loader).map((l) => `categories:${l}`));
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

export async function versaoPorId(versaoId) {
  const v = await pedirJson(`${BASE}/version/${encodeURIComponent(versaoId)}`, { ttl: TTL.medio });
  return normalizarVersao(v);
}

/** A mais nova entre as compatíveis, preferindo release a beta/alpha. */
export function melhorVersao(lista) {
  if (!lista.length) return null;
  const porData = [...lista].sort((a, b) => new Date(b.publicado) - new Date(a.publicado));
  return porData.find((v) => v.canal === 'release') ?? porData[0];
}
