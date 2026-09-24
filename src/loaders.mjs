// Metadados dos modloaders: versões disponíveis, URL do instalador e o id de versão
// que o launcher oficial usa no launcher_profiles.json.

import { pedirJson, pedirTexto, TTL } from './http.mjs';

export const LOADERS = [
  { id: 'fabric', nome: 'Fabric', descricao: 'Leve e rápido de atualizar. Domina os mods de performance.' },
  { id: 'neoforge', nome: 'NeoForge', descricao: 'Sucessor do Forge. Padrão nas versões novas.' },
  { id: 'forge', nome: 'Forge', descricao: 'O clássico. Onde vivem os packs grandes e antigos.' },
  { id: 'quilt', nome: 'Quilt', descricao: 'Derivado do Fabric, compatível com a maioria dos mods dele.' },
];

const idsValidos = new Set(LOADERS.map((l) => l.id));
export const loaderValido = (id) => idsValidos.has(id);

/** Versões do Minecraft, mais novas primeiro. A Modrinth já devolve ordenado. */
export async function versoesDoJogo() {
  const tags = await pedirJson('https://api.modrinth.com/v2/tag/game_version', { ttl: TTL.longo });
  return tags.map((t) => ({ versao: t.version, tipo: t.version_type, data: t.date }));
}

// ---- Fabric / Quilt ---------------------------------------------------------------

// O Fabric marca só a versão atual como "stable". Isso não torna as anteriores
// instáveis — elas são apenas mais antigas. Guardamos as duas noções separadas:
// `recomendada` é a que o próprio projeto indica, `estavel` é não ser pré-lançamento.
const ehPreLancamento = (v) => /beta|alpha|rc|snapshot/i.test(v);

async function versoesFabric(mc) {
  const lista = await pedirJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`, {
    ttl: TTL.longo,
  });
  return lista.map((e) => ({
    versao: e.loader.version,
    estavel: !ehPreLancamento(e.loader.version),
    recomendada: e.loader.stable === true,
  }));
}

async function versoesQuilt(mc) {
  const lista = await pedirJson(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`, {
    ttl: TTL.longo,
  });
  const primeiraEstavel = lista.find((e) => !ehPreLancamento(e.loader.version))?.loader.version;
  return lista.map((e) => ({
    versao: e.loader.version,
    estavel: !ehPreLancamento(e.loader.version),
    recomendada: e.loader.version === primeiraEstavel,
  }));
}

// ---- Forge ------------------------------------------------------------------------

async function versoesForge(mc) {
  const xml = await pedirTexto('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', {
    ttl: TTL.longo,
  });
  const todas = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);

  let recomendada = null;
  try {
    const promos = await pedirJson(
      'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
      { ttl: TTL.longo },
    );
    recomendada = promos.promos?.[`${mc}-recommended`] ?? null;
  } catch {
    // promoções são um luxo; a lista do maven já basta
  }

  const prefixo = `${mc}-`;
  return todas
    .filter((v) => v.startsWith(prefixo))
    // o maven lista em ordem crescente; queremos a mais nova primeiro
    .reverse()
    .map((v) => {
      const versao = v.slice(prefixo.length).split('-')[0];
      return { versao, estavel: versao === recomendada, recomendada: versao === recomendada };
    });
}

// ---- NeoForge ---------------------------------------------------------------------

/** 21.1.x -> 1.21.1 | 20.4.x -> 1.20.4 | 21.0.x -> 1.21 | 26.3.x -> 26.3 */
export function neoforgeParaMinecraft(versao) {
  const [a, b] = versao.split('.');
  if (Number(a) >= 26) return `${a}.${b}`; // versionamento novo, por ano
  return b === '0' ? `1.${a}` : `1.${a}.${b}`;
}

async function versoesNeoforge(mc) {
  const dados = await pedirJson(
    'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
    { ttl: TTL.longo },
  );
  const compativeis = (dados.versions ?? []).filter((v) => neoforgeParaMinecraft(v) === mc).reverse();
  const primeiraEstavel = compativeis.find((v) => !ehPreLancamento(v));
  return compativeis.map((v) => ({
    versao: v,
    estavel: !ehPreLancamento(v),
    recomendada: v === primeiraEstavel,
  }));
}

/** Versões do loader para um Minecraft específico, mais novas primeiro. */
export async function versoesDoLoader(loader, mc) {
  if (!loaderValido(loader)) throw new Error(`Modloader desconhecido: ${loader}`);
  if (!mc) return [];
  switch (loader) {
    case 'fabric':
      return versoesFabric(mc);
    case 'quilt':
      return versoesQuilt(mc);
    case 'forge':
      return versoesForge(mc);
    case 'neoforge':
      return versoesNeoforge(mc);
    default:
      return [];
  }
}

/** A versão que a interface já vem com ela escolhida. */
export function versaoSugerida(lista) {
  return (
    lista.find((v) => v.recomendada)?.versao ??
    lista.find((v) => v.estavel)?.versao ??
    lista[0]?.versao ??
    null
  );
}

/**
 * Tudo que o instalador precisa saber para colocar o loader na máquina do amigo.
 * `versionId` é o nome da pasta em .minecraft/versions e o valor de lastVersionId.
 */
export async function planoDeInstalacao(loader, mc, versaoLoader) {
  switch (loader) {
    case 'fabric': {
      const inst = await pedirJson('https://meta.fabricmc.net/v2/versions/installer', { ttl: TTL.longo });
      const estavel = inst.find((i) => i.stable) ?? inst[0];
      return {
        tipo: 'fabric',
        instaladorUrl: estavel.url,
        instaladorArquivo: `fabric-installer-${estavel.version}.jar`,
        argumentos: ['client', '-dir', '{MC_DIR}', '-mcversion', mc, '-loader', versaoLoader, '-noprofile'],
        versionId: `fabric-loader-${versaoLoader}-${mc}`,
      };
    }
    case 'quilt': {
      const inst = await pedirJson('https://meta.quiltmc.org/v3/versions/installer', { ttl: TTL.longo });
      const estavel = inst[0];
      return {
        tipo: 'quilt',
        instaladorUrl: estavel.url,
        instaladorArquivo: `quilt-installer-${estavel.version}.jar`,
        argumentos: [
          'install', 'client', mc, versaoLoader,
          '--install-dir={MC_DIR}', '--no-profile',
        ],
        versionId: `quilt-loader-${versaoLoader}-${mc}`,
      };
    }
    case 'forge': {
      const completa = `${mc}-${versaoLoader}`;
      return {
        tipo: 'forge',
        instaladorUrl: `https://maven.minecraftforge.net/net/minecraftforge/forge/${completa}/forge-${completa}-installer.jar`,
        instaladorArquivo: `forge-${completa}-installer.jar`,
        argumentos: ['--installClient', '{MC_DIR}'],
        versionId: `${mc}-forge-${versaoLoader}`,
      };
    }
    case 'neoforge': {
      return {
        tipo: 'neoforge',
        instaladorUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${versaoLoader}/neoforge-${versaoLoader}-installer.jar`,
        instaladorArquivo: `neoforge-${versaoLoader}-installer.jar`,
        argumentos: ['--installClient', '{MC_DIR}'],
        versionId: `neoforge-${versaoLoader}`,
      };
    }
    default:
      throw new Error(`Modloader desconhecido: ${loader}`);
  }
}

/**
 * Instalação do lado servidor. Os instaladores são os mesmos jars, mas o
 * subcomando é outro e eles ainda precisam baixar o jar do Minecraft, coisa que
 * no cliente o launcher já fez.
 */
export async function planoDeInstalacaoServidor(loader, mc, versaoLoader) {
  const cliente = await planoDeInstalacao(loader, mc, versaoLoader);
  switch (loader) {
    case 'fabric':
      return {
        ...cliente,
        argumentos: ['server', '-mcversion', mc, '-loader', versaoLoader, '-downloadMinecraft', '-dir', '{DIR}'],
        // O instalador do Fabric deixa este jar pronto para subir o servidor.
        lancador: 'fabric-server-launch.jar',
      };
    case 'quilt':
      return {
        ...cliente,
        argumentos: ['install', 'server', mc, versaoLoader, '--install-dir={DIR}', '--download-server'],
        lancador: 'quilt-server-launch.jar',
      };
    case 'forge':
      return { ...cliente, argumentos: ['--installServer', '{DIR}'], lancador: null };
    case 'neoforge':
      return { ...cliente, argumentos: ['--install-server', '{DIR}'], lancador: null };
    default:
      throw new Error(`Modloader desconhecido: ${loader}`);
  }
}

/** Mods de Fabric costumam rodar no Quilt; o contrário não vale. */
export function loadersAceitos(loader) {
  if (loader === 'quilt') return ['quilt', 'fabric'];
  return [loader];
}
