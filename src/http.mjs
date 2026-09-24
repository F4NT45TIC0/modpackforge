// Camada HTTP compartilhada: cache em memória, fila por host e retry com backoff.
// Zero dependências — Node 24 já traz fetch, AbortSignal.timeout e crypto.

// A Modrinth pede um User-Agent que identifique o app e um jeito de contato.
export const USER_AGENT =
  'ModpackForge/1.0 (modpack builder; +https://github.com/F4NT45TIC0/modpackforge)';

const cache = new Map(); // chave -> { expira, dados }
const emVoo = new Map(); // chave -> Promise (deduplica requisições idênticas simultâneas)

const MAX_CACHE = 600;

function lerCache(chave) {
  const hit = cache.get(chave);
  if (!hit) return undefined;
  if (hit.expira < Date.now()) {
    cache.delete(chave);
    return undefined;
  }
  // LRU pobre: reinsere para marcar como recente
  cache.delete(chave);
  cache.set(chave, hit);
  return hit.dados;
}

function gravarCache(chave, dados, ttl) {
  if (ttl <= 0) return;
  cache.set(chave, { expira: Date.now() + ttl, dados });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

export function limparCache(prefixo = '') {
  for (const k of [...cache.keys()]) if (k.startsWith(prefixo)) cache.delete(k);
}

// ---- fila de concorrência por host -------------------------------------------------
const filas = new Map(); // host -> { ativos, limite, espera[] }

function fila(host) {
  let f = filas.get(host);
  if (!f) {
    f = { ativos: 0, limite: 6, espera: [] };
    filas.set(host, f);
  }
  return f;
}

function adquirir(host) {
  const f = fila(host);
  if (f.ativos < f.limite) {
    f.ativos++;
    return Promise.resolve();
  }
  return new Promise((resolve) => f.espera.push(resolve));
}

function liberar(host) {
  const f = fila(host);
  const proximo = f.espera.shift();
  if (proximo) proximo();
  else f.ativos--;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export class ErroHttp extends Error {
  constructor(status, url, corpo) {
    super(`HTTP ${status} em ${url}`);
    this.name = 'ErroHttp';
    this.status = status;
    this.url = url;
    this.corpo = corpo;
  }
}

/**
 * GET/POST JSON com cache, fila por host e retry.
 * @param {string} url
 * @param {{metodo?:string, corpo?:any, headers?:object, ttl?:number, tentativas?:number, timeout?:number}} opcoes
 */
export async function pedirJson(url, opcoes = {}) {
  const {
    metodo = 'GET',
    corpo,
    headers = {},
    ttl = 0,
    tentativas = 3,
    timeout = 20000,
  } = opcoes;

  const chave = `${metodo} ${url} ${corpo ? JSON.stringify(corpo) : ''}`;
  if (ttl > 0) {
    const guardado = lerCache(chave);
    if (guardado !== undefined) return guardado;
    const pendente = emVoo.get(chave);
    if (pendente) return pendente;
  }

  const executar = (async () => {
    const host = new URL(url).host;
    await adquirir(host);
    try {
      let ultimoErro;
      for (let n = 0; n < tentativas; n++) {
        try {
          const resposta = await fetch(url, {
            method: metodo,
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
              ...(corpo ? { 'Content-Type': 'application/json' } : {}),
              ...headers,
            },
            body: corpo ? JSON.stringify(corpo) : undefined,
            signal: AbortSignal.timeout(timeout),
          });

          if (resposta.status === 429 || resposta.status >= 500) {
            const espera = Number(resposta.headers.get('retry-after')) * 1000;
            ultimoErro = new ErroHttp(resposta.status, url, await resposta.text().catch(() => ''));
            if (n < tentativas - 1) {
              await dormir(Number.isFinite(espera) && espera > 0 ? Math.min(espera, 10000) : 400 * 2 ** n);
              continue;
            }
            throw ultimoErro;
          }

          if (!resposta.ok) {
            throw new ErroHttp(resposta.status, url, await resposta.text().catch(() => ''));
          }

          const dados = await resposta.json();
          gravarCache(chave, dados, ttl);
          return dados;
        } catch (erro) {
          ultimoErro = erro;
          // Erro de rede/timeout: vale repetir. Erro de status 4xx: não vale.
          if (erro instanceof ErroHttp && erro.status < 500 && erro.status !== 429) throw erro;
          if (n === tentativas - 1) throw erro;
          await dormir(400 * 2 ** n);
        }
      }
      throw ultimoErro;
    } finally {
      liberar(host);
    }
  })();

  if (ttl > 0) {
    emVoo.set(chave, executar);
    executar.finally(() => emVoo.delete(chave)).catch(() => {});
  }
  return executar;
}

/** Igual ao pedirJson, mas devolve texto (usado no maven-metadata.xml do Forge). */
export async function pedirTexto(url, { ttl = 0, timeout = 20000 } = {}) {
  const chave = `TEXT ${url}`;
  if (ttl > 0) {
    const guardado = lerCache(chave);
    if (guardado !== undefined) return guardado;
  }
  const host = new URL(url).host;
  await adquirir(host);
  try {
    const resposta = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeout),
    });
    if (!resposta.ok) throw new ErroHttp(resposta.status, url, '');
    const texto = await resposta.text();
    gravarCache(chave, texto, ttl);
    return texto;
  } finally {
    liberar(host);
  }
}

export const TTL = {
  curto: 5 * 60 * 1000, // buscas
  medio: 30 * 60 * 1000, // projetos e versões de mod
  longo: 6 * 60 * 60 * 1000, // metadados de loader e versões do jogo
};
