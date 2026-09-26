// ModpackForge — interface.
// O servidor guarda as chaves e o cache; aqui só desenhamos e reagimos.
// As regras de conflito vêm do mesmo módulo que o resolver usa no servidor,
// então o bloqueio aparece na hora, sem ida e volta.

import { checarCandidato, mesmoMod } from '/compartilhado/conflitos.mjs';
import { montarMrpackEditado } from '/editar-mrpack.mjs';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const estado = {
  inicio: null,
  loader: null,
  mc: null,
  loaderVersao: null,
  mostrarInstaveis: false,
  consulta: '',
  ordem: 'relevance',
  fontes: 'ambas',
  tipo: 'mod',
  categorias: new Set(),
  pagina: 0,
  resultados: [],
  temMais: false,
  buscando: false,
  buscaId: 0,
  falhouPagina: false,
  pack: new Map(), // chave -> { fonte, projetoId, nome, slug, icone, versaoId }
  importado: null, // modpack publicado e arquivos originais, inclusive configs
  plano: null,
  resolvendo: false,
  resolucaoId: 0,
  vistos: new Set(), // para animar só as dependências que acabaram de chegar
};

const chaveDe = (fonte, id) => `${fonte}:${id}`;

// --------------------------------------------------- pack guardado no navegador
// Um F5 sem querer não pode custar meia hora de escolha de mods.

const GUARDADO = 'modpackforge:rascunho';

function guardarRascunho() {
  try {
    localStorage.setItem(
      GUARDADO,
      JSON.stringify({
        loader: estado.loader,
        mc: estado.mc,
        nome: $('#nomePack').value,
        pack: [...estado.pack.values()],
        importado: estado.importado,
      }),
    );
  } catch {
    // Modo anônimo ou armazenamento cheio: seguir sem guardar é aceitável.
  }
}

function lerRascunho() {
  try {
    const cru = localStorage.getItem(GUARDADO);
    return cru ? JSON.parse(cru) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ rede

async function api(caminho, opcoes = {}) {
  const resposta = await fetch(caminho, {
    ...opcoes,
    headers: opcoes.corpo ? { 'Content-Type': 'application/json' } : {},
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
    method: opcoes.corpo ? 'POST' : 'GET',
  });
  const dados = await resposta.json().catch(() => ({ erro: 'Resposta inesperada do servidor' }));
  if (!resposta.ok) {
    const erro = new Error(dados.erro ?? `Erro ${resposta.status}`);
    erro.codigo = dados.codigo;
    erro.status = resposta.status;
    throw erro;
  }
  return dados;
}

let timerAviso;
function mostrarAviso(texto, tipo = 'info') {
  const caixa = $('#avisoFlutuante');
  caixa.textContent = texto;
  caixa.dataset.tipo = tipo;
  caixa.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => { caixa.hidden = true; }, 5200);
}

const formatarNumero = (n) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0);

const formatarTamanho = (b) =>
  b >= 1_073_741_824 ? `${(b / 1_073_741_824).toFixed(1)} GB`
    : b >= 1_048_576 ? `${Math.round(b / 1_048_576)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`;

/** Plural simples: "1 mod", "2 mods". */
const contar = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;

// Ícones de traço reto, pontas quadradas — combinam com o resto blocado.
const ICONES = {
  mais: '<path d="M8 3v10M3 8h10"/>',
  menos: '<path d="M3 8h10"/>',
  cadeado: '<rect x="3.5" y="7.5" width="9" height="6.5"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/>',
  aviso: '<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3M8 11.5v.5"/>',
  junto: '<rect x="2.5" y="5.5" width="7" height="7"/><path d="M6.5 5.5v-3h7v7h-3"/>',
  baixado: '<path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10"/>',
};
const icone = (nome) => `<svg class="icone" viewBox="0 0 16 16" aria-hidden="true">${ICONES[nome]}</svg>`;
const urlDownloadSeguro = (valor) => {
  try { return new URL(valor).protocol === 'https:'; } catch { return false; }
};

// ------------------------------------------------------------- inicialização

async function iniciar() {
  try {
    estado.inicio = await api('/api/inicio');
  } catch {
    document.body.innerHTML =
      '<p style="padding:2rem;font-family:sans-serif;color:#e6e4f0">Não consegui falar com o servidor. Recarregue a página — e, se o ModpackForge estiver rodando no seu PC, feche e abra de novo.</p>';
    return;
  }

  desenharLoaders();
  desenharVersoesJogo();
  desenharCategorias();

  const rascunho = lerRascunho();
  const pref = estado.inicio.preferencias;

  escolherLoader(rascunho?.loader || pref.ultimoLoader || 'fabric');

  const versaoDesejada = rascunho?.mc || pref.ultimaVersaoJogo;
  if (versaoDesejada) {
    const existe = [...$('#versaoJogo').options].some((o) => o.value === versaoDesejada);
    if (existe) $('#versaoJogo').value = versaoDesejada;
  }

  if (rascunho?.pack?.length) {
    for (const m of rascunho.pack) estado.pack.set(chaveDe(m.fonte, m.projetoId), m);
  }
  if (rascunho?.nome) $('#nomePack').value = rascunho.nome;
  if (rascunho?.importado?.projeto?.id && Array.isArray(rascunho.importado.arquivos)) {
    estado.importado = rascunho.importado;
    estado.importado.removidos ??= [];
    escolherLoader(estado.importado.alvo.loader);
    const seletor = $('#versaoJogo');
    if (![...seletor.options].some((o) => o.value === estado.importado.alvo.mc)) {
      seletor.add(new Option(estado.importado.alvo.mc, estado.importado.alvo.mc));
    }
    seletor.value = estado.importado.alvo.mc;
    mostrarAviso(`Voltei com ${estado.importado.projeto.nome} para edição.`);
  } else if (rascunho?.pack?.length) {
    mostrarAviso(`Voltei com o seu pack de antes: ${contar(rascunho.pack.length, 'item', 'itens')}.`);
  }

  await trocarVersaoJogo();
  if (estado.importado) travarAlvoImportado();
  ligarEventos();
  // Com rascunho, resolve de novo; sem, desenha o inventário vazio.
  if (estado.pack.size) agendarResolucao();
  else desenharPack();
}

function desenharLoaders() {
  $('#loaders').innerHTML = estado.inicio.loaders
    .map(
      (l) =>
        `<button type="button" class="loader-opcao" data-loader="${esc(l.id)}" aria-pressed="false"
          aria-label="${esc(l.nome)} — ${esc(l.descricao)}" title="${esc(l.descricao)}">${esc(l.nome)}</button>`,
    )
    .join('');
}

function desenharVersoesJogo() {
  const lista = estado.inicio.versoesDoJogo.filter(
    (v) => estado.mostrarInstaveis || v.tipo === 'release',
  );
  const anterior = $('#versaoJogo').value;
  $('#versaoJogo').innerHTML = lista
    .map((v) => `<option value="${esc(v.versao)}">${esc(v.versao)}${v.tipo !== 'release' ? ' · ' + esc(v.tipo) : ''}</option>`)
    .join('');
  if (anterior && lista.some((v) => v.versao === anterior)) $('#versaoJogo').value = anterior;
  estado.mc = $('#versaoJogo').value;
}

function desenharCategorias() {
  $('#categorias').innerHTML = (estado.inicio.categoriasPorTipo?.[estado.tipo] ?? estado.inicio.categorias)
    .map((c) => `<button type="button" class="categoria" data-cat="${esc(c.id)}" aria-pressed="false">${esc(c.nome)}</button>`)
    .join('');
}

function escolherLoader(id) {
  estado.loader = id;
  for (const b of document.querySelectorAll('.loader-opcao')) {
    b.setAttribute('aria-pressed', String(b.dataset.loader === id));
  }
}

async function trocarVersaoJogo() {
  estado.mc = $('#versaoJogo').value;
  await carregarVersoesLoader();
  reiniciarBusca();
}

async function carregarVersoesLoader() {
  const seletor = $('#versaoLoader');
  seletor.disabled = true;
  seletor.innerHTML = '<option>carregando…</option>';
  try {
    const { versoes, sugerida } = await api(
      `/api/loader-versoes?loader=${encodeURIComponent(estado.loader)}&mc=${encodeURIComponent(estado.mc)}`,
    );
    if (!versoes.length) {
      seletor.innerHTML = '<option value="">nenhuma para essa versão</option>';
      estado.loaderVersao = null;
      atualizarBotaoExportar();
      return;
    }
    seletor.innerHTML = versoes
      .map((v) => `<option value="${esc(v.versao)}">${esc(v.versao)}${v.recomendada ? ' · recomendada' : v.estavel ? '' : ' · instável'}</option>`)
      .join('');
    seletor.value = sugerida ?? versoes[0].versao;
    estado.loaderVersao = seletor.value;
    seletor.disabled = false;
  } catch (erro) {
    seletor.innerHTML = '<option value="">erro ao carregar</option>';
    mostrarAviso(`Não consegui listar as versões do loader: ${erro.message}`, 'erro');
  }
  atualizarBotaoExportar();
  atualizarResumoAlvo();
}

/** A linha que resume a escolha no celular, lida como frase. */
function atualizarResumoAlvo() {
  const nomeLoader = estado.inicio?.loaders.find((l) => l.id === estado.loader)?.nome ?? estado.loader;
  $('#resumoAlvo').textContent = estado.mc
    ? `Minecraft ${estado.mc} com ${nomeLoader}${estado.loaderVersao ? ` ${estado.loaderVersao}` : ''}`
    : 'Escolha a versão';
}

function travarAlvoImportado() {
  const importado = estado.importado;
  $('#versaoJogo').disabled = Boolean(importado);
  $('#mostrarInstaveis').disabled = Boolean(importado);
  for (const botao of document.querySelectorAll('.loader-opcao')) botao.disabled = Boolean(importado);
  if (importado) {
    const versao = importado.alvo.loaderVersao;
    const seletor = $('#versaoLoader');
    if (![...seletor.options].some((o) => o.value === versao)) seletor.add(new Option(versao, versao));
    seletor.value = versao;
    seletor.disabled = true;
    estado.loaderVersao = versao;
  } else {
    $('#versaoLoader').disabled = !estado.loaderVersao;
  }
  atualizarResumoAlvo();
  atualizarBotaoExportar();
}

function arquivosOriginaisAtivos() {
  if (!estado.importado) return [];
  const removidos = new Set(estado.importado.removidos);
  return estado.importado.arquivos.filter((a) => !removidos.has(a.caminho));
}

function originalNoPack(projetoId) {
  return arquivosOriginaisAtivos().some((a) => a.projetoId === projetoId);
}

// ------------------------------------------------ gaveta do pack (celular)

function abrirGaveta() {
  document.body.dataset.packAberto = 'sim';
  $('#fundoPack').hidden = false;
  $('#abrirPack').setAttribute('aria-expanded', 'true');
  // O foco entra na gaveta; sem isso o teclado continuaria na lista escondida atrás.
  setTimeout(() => $('#fecharPack').focus(), 60);
}

function fecharGaveta({ devolverFoco = true } = {}) {
  if (document.body.dataset.packAberto !== 'sim') return;
  delete document.body.dataset.packAberto;
  $('#fundoPack').hidden = true;
  $('#abrirPack').setAttribute('aria-expanded', 'false');
  if (devolverFoco) $('#abrirPack').focus();
}

// -------------------------------------------------------------------- busca

let timerBusca;
function reiniciarBusca() {
  estado.pagina = 0;
  estado.resultados = [];
  estado.temMais = false;
  estado.falhouPagina = false;
  $('#resultados').scrollTop = 0;
  buscar();
}

// ------------------------------------------------------- rolagem infinita
//
// A próxima página é pedida quando a rolagem chega perto do fim. A folga de
// 700px faz o pedido sair antes de a pessoa bater no fim, então a lista cresce
// sem solavanco.

const FOLGA = 700;

const sentinela = document.createElement('li');
sentinela.className = 'sentinela';

/** Em telas largas quem rola é a lista; em telas estreitas, a página. */
function pertoDoFim() {
  const lista = $('#resultados');
  if (lista.scrollHeight > lista.clientHeight + 4) {
    return lista.scrollTop + lista.clientHeight >= lista.scrollHeight - FOLGA;
  }
  const doc = document.documentElement;
  return window.scrollY + window.innerHeight >= doc.scrollHeight - FOLGA;
}

let checagemAgendada = false;
function checarRolagem() {
  if (checagemAgendada) return;
  checagemAgendada = true;
  setTimeout(() => {
    checagemAgendada = false;
    if (pertoDoFim()) pedirProximaPagina();
  }, 120);
}

function pedirProximaPagina() {
  if (estado.buscando || !estado.temMais || estado.falhouPagina) return;
  estado.pagina++;
  buscar();
}

function atualizarSentinela() {
  if (estado.buscando && estado.pagina > 0) {
    sentinela.textContent = 'carregando mais…';
    sentinela.dataset.estado = 'carregando';
  } else if (estado.falhouPagina) {
    sentinela.textContent = '';
    sentinela.dataset.estado = 'erro';
  } else if (estado.temMais) {
    sentinela.textContent = '';
    sentinela.dataset.estado = 'espera';
  } else {
    sentinela.textContent = estado.resultados.length
      ? `Fim da lista: ${estado.resultados.length} resultados`
      : '';
    sentinela.dataset.estado = 'fim';
  }
}

async function buscar() {
  if (!estado.loader || !estado.mc) return;
  const buscaId = ++estado.buscaId;
  const seletores = ['#consulta', '#ordem', '#fontes'];
  for (const s of seletores) $(s).disabled = false;
  $('#fontes').disabled = estado.tipo !== 'mod';

  estado.buscando = true;
  estado.falhouPagina = false;
  if (estado.pagina === 0) {
    // Esqueleto com a forma das linhas: a lista não pula quando os mods chegam.
    const esqueleto = `<li class="mod mod-esqueleto" aria-hidden="true">
      <div class="mod-slot"></div>
      <div class="mod-info"><span class="barra barra-1"></span><span class="barra barra-2"></span><span class="barra barra-3"></span></div>
    </li>`;
    $('#resultados').innerHTML = esqueleto.repeat(6);
    $('#resultados').setAttribute('aria-busy', 'true');
  }
  atualizarSentinela();

  const params = new URLSearchParams({
    q: estado.consulta,
    loader: estado.loader,
    mc: estado.mc,
    ordem: estado.ordem,
    pagina: String(estado.pagina),
    tipo: estado.tipo,
  });
  if (estado.fontes !== 'ambas') params.set('fontes', estado.fontes);
  if (estado.categorias.size) params.set('categorias', [...estado.categorias].join(','));

  try {
    const dados = await api(`/api/buscar?${params}`);
    if (buscaId !== estado.buscaId) return;

    if (estado.pagina === 0) {
      estado.resultados = dados.itens;
      estado.temMais = dados.temMais === true;
    } else {
      // As duas lojas são paginadas em separado e podem devolver o mesmo mod em
      // páginas diferentes. Sem isso a lista repetiria linhas.
      const vistos = new Set(estado.resultados.map((m) => chaveDe(m.fonte, m.id)));
      const novos = dados.itens.filter((m) => !vistos.has(chaveDe(m.fonte, m.id)));
      estado.resultados = [...estado.resultados, ...novos];
      // Página sem nada novo significa que a lista acabou de verdade; insistir
      // só traria as mesmas linhas.
      estado.temMais = dados.temMais === true && novos.length > 0;
    }

    desenharAvisosDaBusca(dados.avisos);
    desenharResultados();
    // Se a página nova ainda não encheu a área visível, segue buscando.
    checarRolagem();
  } catch (erro) {
    if (buscaId !== estado.buscaId) return;
    estado.falhouPagina = true;
    if (estado.pagina === 0) {
      // Sem redesenhar depois: a lista está vazia, e o redesenho trocaria o erro
      // real por "nenhum mod para essa combinação", mandando procurar o problema
      // no lugar errado.
      const lista = $('#resultados');
      lista.removeAttribute('aria-busy');
      lista.innerHTML = `<li class="carregando">Não consegui buscar os mods: ${esc(erro.message)}</li>`;
    } else {
      estado.pagina--; // a página não entrou; tentar de novo repete esta, não a seguinte
      mostrarAviso(`Não consegui carregar mais mods: ${erro.message}`, 'erro');
      desenharResultados();
    }
  } finally {
    if (buscaId === estado.buscaId) {
      estado.buscando = false;
      atualizarSentinela();
    }
  }
}

/**
 * Um aviso de busca só serve se disser o que fazer. Quando o problema é a chave
 * da CurseForge, o aviso leva direto para onde se resolve.
 */
function desenharAvisosDaBusca(avisos = []) {
  const caixa = $('#avisosBusca');
  if (!avisos.length) {
    caixa.hidden = true;
    caixa.innerHTML = '';
    return;
  }
  caixa.hidden = false;
  caixa.innerHTML = avisos
    .map((a) => {
      const texto = typeof a === 'string' ? a : a.texto;
      const codigo = typeof a === 'string' ? null : a.codigo;
      // No site o visitante não troca a chave, então o atalho só aparece no PC.
      const podeTrocar = estado.inicio?.modo !== 'nuvem';
      const acao = podeTrocar && ['CF_CHAVE_INVALIDA', 'CF_SEM_CHAVE'].includes(codigo)
        ? '<button class="alerta-acao" data-abrir-config="1">Trocar a chave nas configurações</button>'
        : '';
      return `<div>${esc(texto)}${acao}</div>`;
    })
    .join('');
}

/** Os mods que já estão no pack, do jeito que checarCandidato espera. */
function escolhidosParaChecagem() {
  const adicionais = estado.plano?.arquivos?.length
    ? estado.plano.arquivos
    : [...estado.pack.values()].map((m) => ({ ...m, incompativeis: [] }));
  return [...adicionais, ...arquivosOriginaisAtivos().map((a) => ({
    chave: a.projetoId ? chaveDe('modrinth', a.projetoId) : `original:${a.caminho}`, fonte: a.projetoId ? 'modrinth' : 'original', projetoId: a.projetoId,
    nome: a.nome, slug: a.slug, tipo: a.tipo, incompativeis: [],
    modId: a.modId, sha1: a.sha1,
  })), ...estado.pack.values()];
}

function desenharResultados() {
  const lista = $('#resultados');
  lista.removeAttribute('aria-busy');
  if (!estado.resultados.length) {
    lista.innerHTML = `<li class="carregando">${
      estado.consulta ? 'Nada com esse nome para ' + esc(estado.mc) + '.' : 'Nenhum resultado para essa combinação.'
    }</li>`;
    $('#carregarMais').hidden = true;
    $('.rodape-lista').hidden = true;
    return;
  }

  const jaNoPack = escolhidosParaChecagem();

  // Mods que já entraram como dependência de outro. Sem essa marca, a lista
  // oferecia "Adicionar" para algo que já está no pack.
  const vemJunto = new Map(
    (estado.plano?.arquivos ?? []).filter((a) => a.origem === 'dependencia').map((a) => [a.chave, a]),
  );

  lista.innerHTML = estado.resultados
    .map((mod) => {
      const chave = chaveDe(mod.fonte, mod.id);
      const dentro = estado.pack.has(chave);
      const noOriginal = mod.fonte === 'modrinth' && originalNoPack(mod.id);
      const dependencia = !dentro ? vemJunto.get(chave) : null;
      const choques = estado.tipo !== 'mod' || dentro || noOriginal || dependencia ? [] : checarCandidato(mod, jaNoPack);
      const bloqueio = choques.find((c) => c.severidade === 'bloqueio');
      const aviso = choques.find((c) => c.severidade === 'aviso');

      const estadoLinha = dentro || noOriginal ? 'no-pack' : dependencia ? 'dependencia' : bloqueio ? 'bloqueado' : 'livre';
      const nome = esc(mod.nome);

      // O texto do botão continua no HTML mesmo quando o celular mostra só o
      // ícone: é ele que o leitor de tela anuncia.
      let acao;
      if (mod.tipo === 'modpack') {
        acao = `<button class="botao botao-forte botao-acao" data-detalhe="${esc(chave)}" title="Ver versões de ${nome}">
          ${icone('baixado')}<span class="botao-texto">Baixar</span></button>`;
      } else if (dentro) {
        acao = `<button class="botao botao-acao" data-remover="${esc(chave)}" title="Tirar ${nome} do pack">
          ${icone('menos')}<span class="botao-texto">Tirar</span></button>`;
      } else if (noOriginal) {
        acao = `<button class="botao botao-acao" disabled title="Já está no modpack original">
          ${icone('junto')}<span class="botao-texto">No original</span></button>`;
      } else if (bloqueio) {
        acao = `<button class="botao botao-acao" disabled title="Bloqueado">
          ${icone('cadeado')}<span class="botao-texto">Bloqueado</span></button>`;
      } else if (dependencia) {
        // Continua adicionável — escolher fixa o mod no pack mesmo se quem o
        // exige sair —, mas sem o destaque de lápis: não é preciso.
        acao = `<button class="botao botao-acao" data-adicionar="${esc(chave)}" title="Já vem no pack. Adicionar ${nome} como escolha sua">
          ${icone('mais')}<span class="botao-texto">Adicionar</span></button>`;
      } else {
        acao = `<button class="botao botao-forte botao-acao" data-adicionar="${esc(chave)}" title="Adicionar ${nome} ao pack">
          ${icone('mais')}<span class="botao-texto">Adicionar</span></button>`;
      }

      // O motivo mora dentro da informação, não ao lado do botão: no celular
      // não sobra largura ali, e é aqui que os olhos já estão lendo.
      const motivo = noOriginal
        ? '<p class="mod-motivo" data-tipo="dependencia">Já está no modpack original. Tire a versão original para trocar por outra.</p>'
        : dependencia
        ? `<p class="mod-motivo" data-tipo="dependencia">${icone('junto')}<span>Já vem no pack${
            dependencia.exigidoPor?.length ? `: exigido por ${esc(dependencia.exigidoPor.join(', '))}` : ''
          }</span></p>`
        : bloqueio
        ? `<p class="mod-motivo" data-tipo="bloqueio">${icone('cadeado')}<span>${esc(bloqueio.titulo)}: ${esc(bloqueio.outro.nome)}</span></p>`
        : aviso
          ? `<p class="mod-motivo" data-tipo="aviso">${icone('aviso')}<span>${esc(aviso.titulo)}</span></p>`
          : '';

      const retrato = mod.icone
        ? `<img src="${esc(mod.icone)}" alt="" loading="lazy">`
        : `<span class="mod-slot-vazio">${esc((mod.nome || '?')[0].toUpperCase())}</span>`;

      return `<li class="mod" data-estado="${estadoLinha}" data-chave="${esc(chave)}">
        <div class="mod-slot">${retrato}</div>
        <div class="mod-info">
          <div class="mod-titulo">
            <button class="mod-nome" data-detalhe="${esc(chave)}">${nome}</button>
            ${mod.autor ? `<span class="mod-autor">${esc(mod.autor)}</span>` : ''}
          </div>
          <p class="mod-resumo">${esc(mod.resumo)}</p>
          <div class="mod-meta">
            <span class="loja loja-${esc(mod.fonte)}">${mod.fonte === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>
            <span class="numero" title="${Number(mod.downloads ?? 0).toLocaleString('pt-BR')} downloads">${icone('baixado')}${formatarNumero(mod.downloads)}</span>
            ${mod.categorias.slice(0, 3).map((c) => `<span class="tag">${esc(c)}</span>`).join('')}
          </div>
          ${motivo}
        </div>
        <div class="mod-acao">${acao}</div>
      </li>`;
    })
    .join('');

  // A sentinela é um elemento só, reaproveitado a cada redesenho: ela carrega o
  // estado do fim da lista ("carregando mais…" / "acabou a lista").
  lista.appendChild(sentinela);
  atualizarSentinela();

  // O rodapé só existe como saída manual quando a rolagem automática falha.
  // Fora isso ele fica fora do caminho e a lista fica com a altura toda.
  $('#carregarMais').hidden = !estado.falhouPagina;
  $('.rodape-lista').hidden = !estado.falhouPagina;
}

// --------------------------------------------------------------- o pack

function adicionar(chave) {
  const mod = estado.resultados.find((m) => chaveDe(m.fonte, m.id) === chave);
  if (!mod || estado.pack.has(chave) || (mod.fonte === 'modrinth' && originalNoPack(mod.id))) return;
  const duplicado = escolhidosParaChecagem().find((a) => mesmoMod(mod, a));
  if (duplicado) {
    mostrarAviso(`${duplicado.nome} já está no pack. Remova a cópia atual antes de trocar de loja.`, 'erro');
    return;
  }
  estado.pack.set(chave, {
    fonte: mod.fonte,
    projetoId: mod.id,
    nome: mod.nome,
    slug: mod.slug,
    icone: mod.icone,
    tipo: mod.tipo ?? 'mod',
    versaoId: null,
  });
  agendarResolucao();
  desenharResultados();
}

function remover(chave) {
  estado.pack.delete(chave);
  agendarResolucao();
  desenharResultados();
}

const modsEscolhidos = () =>
  [...estado.pack.entries()].filter(([, item]) => (item.tipo ?? 'mod') === 'mod');
const modsOriginaisAtivos = () => arquivosOriginaisAtivos().filter((a) => a.tipo === 'mod');

function abrirConfirmacaoRemoverMods() {
  const mods = modsEscolhidos();
  const originais = modsOriginaisAtivos();
  if (!mods.length && !originais.length) return;
  $('#textoRemoverMods').textContent =
    `Remover ${contar(mods.length + originais.length, 'mod', 'mods')}? Shaders, recursos e configurações continuam no pack.`;
  $('#janelaRemoverMods').showModal();
}

function confirmarRemocaoMods() {
  const mods = modsEscolhidos();
  const originais = modsOriginaisAtivos();
  $('#janelaRemoverMods').close();
  if (!mods.length && !originais.length) return;
  for (const [chave] of mods) estado.pack.delete(chave);
  if (estado.importado) estado.importado.removidos.push(...originais.map((a) => a.caminho));
  if (!estado.pack.size) estado.vistos.clear();
  estado.plano = null;
  agendarResolucao();
  desenharResultados();
  mostrarAviso(`${contar(mods.length + originais.length, 'mod removido', 'mods removidos')} do pack.`);
}

let timerResolucao;
function agendarResolucao() {
  guardarRascunho();
  estado.resolucaoId++;
  clearTimeout(timerResolucao);
  if (!estado.pack.size) {
    estado.plano = null;
    estado.resolvendo = false;
    desenharPack();
    return;
  }
  estado.resolvendo = true;
  desenharPack();
  timerResolucao = setTimeout(resolverPack, 220);
}

async function resolverPack() {
  const resolucaoId = estado.resolucaoId;
  const itens = [...estado.pack.values()].map((m) => ({
    fonte: m.fonte,
    projetoId: m.projetoId,
    versaoId: m.versaoId,
    tipo: m.tipo ?? 'mod',
  }));
  try {
    const plano = await api('/api/resolver', {
      corpo: { loader: estado.loader, mc: estado.mc, loaderVersao: estado.loaderVersao, itens,
        base: estado.importado ? { projetoId: estado.importado.projeto.id, versaoId: estado.importado.versao.id, removidos: estado.importado.removidos } : null },
    });
    if (resolucaoId !== estado.resolucaoId) return;
    estado.plano = plano;
    for (const erro of estado.plano.erros ?? []) {
      if (erro.codigo === 'CF_SEM_CHAVE') mostrarAviso('Configure a chave da CurseForge para resolver esses mods.', 'erro');
    }
  } catch (erro) {
    if (resolucaoId !== estado.resolucaoId) return;
    mostrarAviso(`Não consegui montar o pack: ${erro.message}`, 'erro');
  } finally {
    if (resolucaoId === estado.resolucaoId) {
      estado.resolvendo = false;
      desenharPack();
      desenharResultados();
    }
  }
}

// --------------------------------------------- o pack como inventário

// Três fileiras de nove, como o inventário principal do jogo. Packs maiores
// mostram um "+N" no último slot; a lista abaixo da grade tem todos.
const SLOTS_NO_INVENTARIO = 27;
const SLOTS_NA_HOTBAR = 9;

function slotDoItem(item, { novo = false, conflito = false } = {}) {
  const retrato = item.icone
    ? `<img src="${esc(item.icone)}" alt="" loading="lazy">`
    : `<span class="slot-letra">${esc((item.nome || '?')[0].toUpperCase())}</span>`;
  return `<span class="slot" data-origem="${esc(item.origem)}"${conflito ? ' data-conflito="sim"' : ''}${
    novo ? ' data-novo="sim"' : ''
  } title="${esc(item.nome)}">${retrato}</span>`;
}

function desenharInventario(itens, marcas) {
  let visiveis = itens;
  let excedente = 0;
  if (itens.length > SLOTS_NO_INVENTARIO) {
    visiveis = itens.slice(0, SLOTS_NO_INVENTARIO - 1);
    excedente = itens.length - visiveis.length;
  }
  const cheios = visiveis.map((i) => slotDoItem(i, marcas(i)));
  if (excedente) cheios.push(`<span class="slot slot-mais" title="mais ${excedente} na lista abaixo">+${excedente}</span>`);

  // Sempre fileiras completas, e pelo menos uma: um inventário vazio também é
  // um convite para encher.
  const total = Math.max(9, Math.ceil(cheios.length / 9) * 9);
  $('#packGrade').innerHTML = cheios.join('') + '<span class="slot"></span>'.repeat(total - cheios.length);
}

function desenharHotbar(itens, marcas, texto, comConflito) {
  const cheios = itens.slice(0, SLOTS_NA_HOTBAR).map((i) => slotDoItem(i, marcas(i)));
  $('#barraSlots').innerHTML =
    cheios.join('') + '<span class="slot"></span>'.repeat(SLOTS_NA_HOTBAR - cheios.length);
  $('#barraTexto').textContent = texto;
  $('#barraPack').dataset.estado = comConflito ? 'bloqueio' : '';
  $('#abrirPack').setAttribute('aria-label', `Abrir o pack: ${texto}`);
}

const semMarcas = () => ({});

function desenharOriginais() {
  const base = estado.importado;
  if (!base) return '';
  const removidos = new Set(base.removidos);
  const ativos = arquivosOriginaisAtivos();
  const linha = (a) => `<li class="pack-item" data-origem="escolhido">
    <span class="pack-slot">${a.icone ? `<img src="${esc(a.icone)}" alt="" loading="lazy">` : ''}</span>
    <span><span class="pack-nome" title="${esc(a.caminho)}">${esc(a.nome)}</span><span class="pack-versao">${a.embutido ? 'Mod incluído no arquivo · ' : ''}${esc(a.caminho)}</span></span>
    <button class="pack-remover" data-remover-original="${esc(a.caminho)}" title="Tirar do modpack" aria-label="Tirar ${esc(a.nome)} do modpack">${icone('menos')}</button>
  </li>`;
  return `<div class="base-importada">
    <div class="base-cabecalho"><strong>${esc(base.projeto.nome)}</strong><button class="botao" data-sair-edicao type="button">Sair da edição</button></div>
    <p class="ajuda">Versão ${esc(base.versao.nome)} · Minecraft ${esc(base.alvo.mc)} · ${esc(base.alvo.loader)} ${esc(base.alvo.loaderVersao)}. Os arquivos de configuração do autor serão mantidos.</p>
    <p class="pack-secao">Arquivos originais (${ativos.length})</p>
    <ul class="pack-lista">${ativos.map(linha).join('')}</ul>
    ${removidos.size ? `<details class="base-detalhes"><summary>Removidos (${removidos.size}) — restaurar</summary><ul class="pack-lista">${base.arquivos.filter((a) => removidos.has(a.caminho)).map((a) => `<li class="pack-item"><span class="pack-slot"></span><span class="pack-nome">${esc(a.nome)}</span><button class="botao" data-restaurar-original="${esc(a.caminho)}">Restaurar</button></li>`).join('')}</ul></details>` : ''}
    <details class="base-detalhes"><summary>Configurações e outros arquivos preservados (${base.configuracoes.length})</summary><ul class="base-configs">${base.configuracoes.map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul></details>
  </div>`;
}

function desenharPack() {
  const corpo = $('#packCorpo');
  const alertas = $('#packAlertas');
  const quantidadeMods = modsEscolhidos().length + modsOriginaisAtivos().length;
  $('#removerTodosMods').disabled = quantidadeMods === 0;
  const originais = arquivosOriginaisAtivos().map((a) => ({ ...a, origem: 'escolhido' }));
  const cabecalho = desenharOriginais();

  if (!estado.pack.size) {
    corpo.innerHTML = cabecalho ||
      '<p class="pack-vazio">Os itens que você escolher aparecem aqui, junto com o que eles exigem.</p>';
    alertas.innerHTML = '';
    $('#packConta').textContent = originais.length ? contar(originais.length, 'arquivo original', 'arquivos originais') : 'Nenhum item ainda';
    $('#packPeso').textContent = estado.importado ? `${contar(estado.importado.configuracoes.length, 'configuração preservada', 'configurações preservadas')}` : '';
    desenharInventario(originais, semMarcas);
    desenharHotbar(originais, semMarcas, originais.length ? contar(originais.length, 'arquivo', 'arquivos') : 'Pack vazio', false);
    atualizarBotaoExportar();
    return;
  }

  const plano = estado.plano;
  if (!plano) {
    // Ainda sem resposta do servidor: mostra o que o usuário escolheu.
    const escolhidosAgora = [...estado.pack.entries()].map(([chave, m]) => ({ ...m, chave, origem: 'escolhido' }));
    corpo.innerHTML = cabecalho + '<p class="carregando">Resolvendo dependências adicionais…</p>';
    $('#packConta').innerHTML = `<span class="legenda" data-tipo="escolhido"><i></i>${contar(estado.pack.size, 'escolhido', 'escolhidos')}</span>`;
    desenharInventario([...originais, ...escolhidosAgora], semMarcas);
    desenharHotbar([...originais, ...escolhidosAgora], semMarcas, 'Resolvendo…', false);
    atualizarBotaoExportar();
    return;
  }

  const escolhidos = plano.arquivos.filter((a) => a.origem === 'escolhido');
  const dependencias = plano.arquivos.filter((a) => a.origem === 'dependencia');

  // Quem está num conflito de bloqueio, e quem acabou de chegar sozinho —
  // calculado antes de marcar tudo como visto.
  const emConflito = new Set(
    plano.conflitos
      .filter((c) => c.severidade === 'bloqueio')
      .flatMap((c) => c.envolvidos.map((e) => e.chave))
      .filter(Boolean),
  );
  const chegaramAgora = new Set(
    dependencias.filter((a) => !estado.vistos.has(a.chave)).map((a) => a.chave),
  );
  const marcas = (a) => ({ novo: chegaramAgora.has(a.chave), conflito: emConflito.has(a.chave) });
  const noInventario = [...originais, ...escolhidos, ...dependencias];

  const linha = (a) => {
    const novo = a.origem === 'dependencia' && !estado.vistos.has(a.chave) ? ' data-novo="sim"' : '';
    const conflito = plano.conflitos.find(
      (c) => c.severidade === 'bloqueio' && c.envolvidos.some((e) => e.chave === a.chave),
    );
    const icone = a.icone ? `<img src="${esc(a.icone)}" alt="" loading="lazy">` : '';
    const porque =
      a.origem === 'dependencia' && a.exigidoPor.length
        ? `<span class="pack-porque">exigido por ${esc(a.exigidoPor.join(', '))}</span>`
        : '';
    return `<li class="pack-item" data-origem="${esc(a.origem)}"${conflito ? ' data-conflito="bloqueio"' : ''}${novo}>
      <span class="pack-slot">${icone}</span>
      <span>
        <span class="pack-nome">${esc(a.nome)}</span>
        <span class="pack-versao">${esc(a.versaoNumero ?? '')}</span>
        ${porque}
      </span>
      ${a.origem === 'escolhido' ? `<button class="pack-remover" data-remover="${esc(a.chave)}" title="Tirar do pack" aria-label="Tirar ${esc(a.nome)} do pack"><svg class="icone" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>` : '<span></span>'}
    </li>`;
  };

  corpo.innerHTML = cabecalho +
    `<p class="pack-secao">Você escolheu (${escolhidos.length})</p>
     <ul class="pack-lista">${escolhidos.map(linha).join('')}</ul>` +
    (dependencias.length
      ? `<p class="pack-secao">Vieram junto (${dependencias.length})</p>
         <ul class="pack-lista">${dependencias.map(linha).join('')}</ul>`
      : '');

  for (const a of plano.arquivos) estado.vistos.add(a.chave);

  // Alertas, do mais grave para o menos.
  const blocos = [];

  // Ajustes que fizemos sozinhos: o usuário precisa saber que a versão que ele
  // veria na loja não é a que vai no pack, e por quê.
  if (plano.trocas?.length) {
    blocos.push(`<div class="alerta alerta-info">
      <strong>${plano.trocas.length === 1 ? 'Uma versão foi ajustada' : `${plano.trocas.length} versões foram ajustadas`}</strong>
      para os mods abrirem juntos.
      <ul class="lista-trocas">${plano.trocas
        .map((t) => `<li>${esc(t.nome)}: <span class="pack-versao">${esc(t.de)}</span> → <span class="pack-versao">${esc(t.para)}</span><br><span class="pack-porque">${esc(t.porque)}</span></li>`)
        .join('')}</ul>
    </div>`);
  }
  for (const c of plano.conflitos.filter((x) => x.severidade === 'bloqueio')) {
    blocos.push(`<div class="alerta alerta-bloqueio">
      <strong>${esc(c.titulo)}</strong> — ${esc(c.motivo)}<br>
      ${esc(c.envolvidos.map((e) => e.nome).join(' e '))}
      <button class="alerta-acao" data-remover="${esc(c.envolvidos[0].chave)}">Tirar ${esc(c.envolvidos[0].nome)}</button>
    </div>`);
  }
  for (const c of plano.conflitos.filter((x) => x.severidade === 'aviso')) {
    blocos.push(`<div class="alerta alerta-aviso">
      <strong>${esc(c.titulo)}</strong> — ${esc(c.motivo)}<br>${esc(c.envolvidos.map((e) => e.nome).join(' e '))}
    </div>`);
  }
  for (const f of plano.faltando) {
    blocos.push(`<div class="alerta alerta-bloqueio">
      <strong>${esc(f.nome)}</strong> é exigido${f.exigidoPor?.length ? ' por ' + esc(f.exigidoPor.join(', ')) : ''}, mas não tem versão para ${esc(estado.loader)} ${esc(estado.mc)}.
    </div>`);
  }
  for (const erro of plano.erros) {
    blocos.push(`<div class="alerta alerta-bloqueio"><strong>Não consegui resolver um arquivo</strong> — ${esc(erro.mensagem)}</div>`);
  }
  if (plano.manuais.length) {
    blocos.push(`<div class="alerta alerta-aviso">
      <strong>${plano.manuais.length} ${plano.manuais.length === 1 ? 'mod precisa' : 'mods precisam'} de download manual</strong> —
      o autor desativou o download automático na CurseForge. O instalador vai abrir as páginas certas.
    </div>`);
  }
  alertas.innerHTML = blocos.join('');

  // A legenda é a chave de cores da grade, e já traz as contagens.
  const bloqueios = plano.resumo.bloqueios ?? 0;
  const legenda = [
    `<span class="legenda" data-tipo="escolhido"><i></i>${contar(escolhidos.length, 'escolhido', 'escolhidos')}</span>`,
  ];
  if (originais.length) legenda.unshift(`<span class="legenda" data-tipo="escolhido"><i></i>${contar(originais.length, 'original', 'originais')}</span>`);
  if (dependencias.length) {
    legenda.push(
      `<span class="legenda" data-tipo="dependencia"><i></i>${dependencias.length} ${dependencias.length === 1 ? 'veio junto' : 'vieram junto'}</span>`,
    );
  }
  if (bloqueios) {
    legenda.push(`<span class="legenda" data-tipo="bloqueio"><i></i>${contar(bloqueios, 'conflito', 'conflitos')}</span>`);
  }
  $('#packConta').innerHTML = legenda.join('');
  $('#packPeso').textContent = plano.resumo.tamanho ? `${formatarTamanho(plano.resumo.tamanho)} para baixar` : '';

  desenharInventario(noInventario, marcas);
  const textoHotbar = bloqueios
    ? contar(bloqueios, 'conflito', 'conflitos')
    : estado.resolvendo
      ? 'Resolvendo…'
      : contar(plano.resumo.total + originais.length, 'item', 'itens');
  desenharHotbar(noInventario, marcas, textoHotbar, bloqueios > 0);

  atualizarBotaoExportar();
}

function atualizarBotaoExportar() {
  const bloqueios = estado.plano?.resumo?.bloqueios ?? 0;
  const pendentes = (estado.plano?.faltando?.length ?? 0) + (estado.plano?.erros?.length ?? 0);
  const pronto = (estado.pack.size > 0 || Boolean(estado.importado)) && estado.loaderVersao && !estado.resolvendo && bloqueios === 0 && pendentes === 0;
  const botao = $('#abrirExportar');
  botao.disabled = !pronto;
  botao.textContent = bloqueios > 0 || pendentes > 0 ? 'Resolva os problemas primeiro' : 'Gerar instalador';
}

// ------------------------------------------------------------- detalhe

async function abrirDetalhe(chave) {
  const mod = estado.resultados.find((m) => chaveDe(m.fonte, m.id) === chave);
  if (!mod) return;
  const janela = $('#janelaDetalhe');
  $('#detalheCorpo').innerHTML = '<p class="carregando">carregando…</p>';
  janela.showModal();

  try {
    const { projeto, versoes } = await api(
      `/api/projeto?fonte=${encodeURIComponent(mod.fonte)}&id=${encodeURIComponent(mod.id)}&tipo=${encodeURIComponent(mod.tipo ?? 'mod')}&loader=${encodeURIComponent(estado.loader)}&mc=${encodeURIComponent(estado.mc)}`,
    );
    const fixada = estado.pack.get(chave)?.versaoId ?? null;

    $('#detalheCorpo').innerHTML = `
      <div class="detalhe-topo">
        <div class="mod-slot">${projeto.icone ? `<img src="${esc(projeto.icone)}" alt="">` : ''}</div>
        <div>
          <h2>${esc(projeto.nome)}</h2>
          <p class="detalhe-sub">${esc(projeto.resumo)}</p>
          <p class="detalhe-sub">
            <span class="loja loja-${esc(projeto.fonte)}">${projeto.fonte === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>
            ${esc(projeto.autor ?? '')} · ${formatarNumero(projeto.downloads)} downloads ·
            <a href="${esc(projeto.pagina)}" target="_blank" rel="noreferrer">abrir página</a>
          </p>
        </div>
      </div>
      <div>
        <p class="pack-secao">Versões ${mod.tipo === 'shader' ? 'de shader' : 'para ' + esc(estado.mc)} (${versoes.length})</p>
        ${mod.tipo !== 'modpack' && mod.fonte === 'modrinth' && originalNoPack(mod.id) ? '<p class="ajuda">Este item já está no modpack original. Tire a versão original no painel do pack para escolher outra.</p>' : ''}
        ${mod.tipo === 'modpack' ? `<div class="campo-dupla">
          <div class="campo-linha"><label for="modpackRam">RAM do servidor</label><select id="modpackRam" class="campo"><option value="4096">4 GB</option><option value="6144">6 GB</option><option value="8192">8 GB</option><option value="12288">12 GB</option></select></div>
          <div class="campo-linha"><label for="modpackPorta">Porta do servidor</label><input id="modpackPorta" class="campo" type="number" min="1" max="65535" value="25565"></div>
        </div><p class="ajuda">Ao escolher uma versão, você recebe o .mrpack para o launcher e um .sh para instalar o servidor Linux.</p>` : ''}
        <div class="detalhe-versoes">
          ${
            versoes.length
              ? versoes
                  .slice(0, 25)
                  .map(
                    (v) => `<div class="detalhe-versao">
                      <span>${esc(v.numero)}<br><span class="numero">${esc(v.arquivo?.nome ?? '')}</span></span>
                      <span class="canal canal-${esc(v.canal)}">${esc(v.canal)}</span>
                      ${mod.tipo === 'modpack'
                        ? `<span class="detalhe-acoes"><button class="botao" data-baixar-pack="${esc(v.id)}" data-projeto="${esc(mod.id)}">Baixar</button><button class="botao botao-forte" data-editar-pack="${esc(v.id)}" data-projeto="${esc(mod.id)}">Editar</button></span>`
                        : `<span class="detalhe-acoes"><button class="botao" data-fixar="${esc(chave)}" data-versao="${esc(v.id)}" ${mod.fonte === 'modrinth' && originalNoPack(mod.id) ? 'disabled' : ''}>${fixada === v.id ? 'fixada' : 'usar esta'}</button>${
                          ['shader', 'resourcepack'].includes(mod.tipo) && v.arquivo?.nome?.toLowerCase().endsWith('.zip') && urlDownloadSeguro(v.arquivo?.url)
                            ? `<a class="botao" href="${esc(v.arquivo.url)}" target="_blank" rel="noreferrer">Baixar .zip</a>` : ''
                        }</span>`}
                    </div>`,
                  )
                  .join('')
              : '<p class="nota">Nenhuma versão compatível.</p>'
          }
        </div>
        ${fixada && mod.tipo !== 'modpack' ? `<button class="botao" data-fixar="${esc(chave)}" data-versao="">Voltar para a mais nova</button>` : ''}
        <div id="resultadoModpack"></div>
      </div>`;
  } catch (erro) {
    $('#detalheCorpo').innerHTML = `<p class="carregando">${esc(erro.message)}</p>`;
  }
}

function mostrarVerificacaoServidor(v) {
  if (!v) return '';
  return `<section class="ajuda"><strong>Verificação do servidor: ${v.status === 'declaracoes-conferidas' ? 'declarações conferidas' : v.status === 'bloqueado' ? 'bloqueado' : 'incompleta'}</strong>
    <p>${v.verificados}/${v.total} JARs conferidos. ${v.javaPermitidos?.length <= 6 ? `Java permitido: ${v.javaPermitidos.join(', ')}` : `Java mínimo: ${v.javaMinimo}`}.</p>
    ${v.avisos.length ? `<details><summary>Avisos (${v.avisos.length})</summary><ul>${v.avisos.map((a) => `<li>${esc(a.texto)}</li>`).join('')}</ul></details>` : ''}
    ${v.bloqueios.length ? `<p>O .sh foi bloqueado. Corrija estes problemas na edição do pack:</p><ul>${v.bloqueios.map((a) => `<li>${esc(a.texto)}</li>`).join('')}</ul>` :
      '<p>Depois de instalar, com o servidor parado, rode <code>bash verificar-servidor.sh</code> na pasta dele. O teste inicia com um mundo temporário, encerra e salva um log. A conferência das declarações não garante que o servidor abra.</p>'}</section>`;
}

async function baixarModpack(projetoId, versaoId, botao) {
  botao.disabled = true;
  botao.textContent = 'Preparando…';
  try {
    const dados = await api('/api/baixar-modpack', {
      corpo: {
        projetoId, versaoId,
        memoriaMb: Number($('#modpackRam').value),
        porta: Number($('#modpackPorta').value),
      },
    });
    for (const url of urlsDeDownload) URL.revokeObjectURL(url);
    urlsDeDownload = dados.servidor ? [urlDoArquivo(dados.servidor.base64)] : [];
    $('#resultadoModpack').innerHTML = `<p class="ajuda"><strong>${esc(dados.resumo.nome)}</strong> — ${esc(dados.resumo.mc)}, ${esc(dados.resumo.loader)} ${esc(dados.resumo.loaderVersao)}. ${dados.resumo.arquivos} arquivos no servidor; ${dados.resumo.excluidos} exclusivos do cliente ficaram de fora.</p>
      <ul class="downloads">
        <li><a class="botao" href="${esc(dados.mrpack.url)}" target="_blank" rel="noreferrer">Baixar ${esc(dados.mrpack.nome)}</a></li>
        ${dados.servidor ? `<li><a class="botao" href="${urlsDeDownload[0]}" download="${esc(dados.servidor.nome)}">Baixar ${esc(dados.servidor.nome)}</a></li>` : ''}
      </ul>
      ${dados.servidor ? `<p class="ajuda">Na VPS: <code>bash ${esc(dados.servidor.nome)}</code>. O script baixa os arquivos do pack, aplica as configurações de servidor e pede o aceite do EULA.</p>` : ''}
      ${mostrarVerificacaoServidor(dados.resumo.verificacao)}
      ${dados.pasta ? `<p class="caminho">O .sh também foi salvo em ${esc(dados.pasta)}</p><button class="botao" id="abrirPastaModpack">Abrir a pasta</button>` : ''}`;
    $('#abrirPastaModpack')?.addEventListener('click', () => api('/api/abrir-pasta', { corpo: { pasta: dados.pasta } }));
  } catch (erro) {
    mostrarAviso(`Falhou ao preparar o modpack: ${erro.message}`, 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = 'Baixar';
  }
}

let substituicaoPendente = null;
async function editarModpack(projetoId, versaoId, botao, confirmado = false) {
  if (!confirmado && (estado.importado || estado.pack.size)) {
    substituicaoPendente = { projetoId, versaoId, botao };
    $('#janelaSubstituirPack').showModal();
    return;
  }
  botao.disabled = true;
  botao.textContent = 'Carregando…';
  try {
    const dados = await api(`/api/importar-modpack?projetoId=${encodeURIComponent(projetoId)}&versaoId=${encodeURIComponent(versaoId)}`);
    estado.importado = { ...dados, removidos: [] };
    estado.pack.clear();
    estado.plano = null;
    estado.vistos.clear();
    escolherLoader(dados.alvo.loader);
    const seletor = $('#versaoJogo');
    if (![...seletor.options].some((o) => o.value === dados.alvo.mc)) seletor.add(new Option(dados.alvo.mc, dados.alvo.mc));
    seletor.value = dados.alvo.mc;
    await trocarVersaoJogo();
    travarAlvoImportado();
    $('#nomePack').value = `${dados.projeto.nome} editado`.slice(0, 80);
    $('#janelaDetalhe').close();
    agendarResolucao();
    desenharResultados();
    if (matchMedia('(max-width: 56.24rem)').matches) abrirGaveta();
    mostrarAviso(`${dados.arquivos.length} arquivos e ${dados.configuracoes.length} configurações carregados para edição.`);
  } catch (erro) {
    mostrarAviso(`Não consegui importar o modpack: ${erro.message}`, 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = 'Editar';
  }
}

function alterarOriginal(caminho, remover) {
  if (!estado.importado?.arquivos.some((a) => a.caminho === caminho)) return;
  const atual = new Set(estado.importado.removidos);
  if (remover) atual.add(caminho);
  else atual.delete(caminho);
  estado.importado.removidos = [...atual];
  agendarResolucao();
  desenharResultados();
}

function sairDaEdicao() {
  estado.importado = null;
  travarAlvoImportado();
  agendarResolucao();
  desenharResultados();
  mostrarAviso('Edição do modpack encerrada. Os itens adicionais continuam no seu pack.');
}

function fixarVersao(chave, versaoId) {
  if (!estado.pack.has(chave)) {
    adicionar(chave);
  }
  const item = estado.pack.get(chave);
  if (!item) return;
  item.versaoId = versaoId || null;
  $('#janelaDetalhe').close();
  agendarResolucao();
  mostrarAviso(versaoId ? `Versão fixada para ${item.nome}.` : `${item.nome} volta a usar a versão mais nova.`);
}

// ------------------------------------------------------------- exportar

// Links de download da última exportação. Guardados para serem liberados na
// próxima, senão cada exportação deixaria os arquivos presos na memória.
let urlsDeDownload = [];

function urlDoArquivo(base64) {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
}

function abrirExportar() {
  $('#expNome').value = $('#nomePack').value.trim() || 'Meu pack';
  $('#resultadoExportar').hidden = true;
  $('#confirmarExportar').disabled = false;
  $('#confirmarExportar').textContent = 'Gerar';
  const editando = Boolean(estado.importado);
  $('#notaFormatos').textContent = editando
    ? 'O .mrpack editado mantém os arquivos e configurações originais. O .sh instala a versão editada no servidor Linux.'
    : 'Na dúvida, deixe os dois marcados: cada um serve a um tipo de launcher, e mandar o arquivo errado faz o pack simplesmente não aparecer no jogo.';
  for (const formato of document.querySelectorAll('input[name="formato"]')) {
    formato.disabled = editando && ['bat', 'txt'].includes(formato.value);
    if (editando) formato.checked = ['mrpack', 'servidor'].includes(formato.value);
    else if (formato.value === 'bat' || formato.value === 'mrpack') formato.checked = true;
  }
  $('#linhaPorta').hidden = !document.querySelector('input[name="formato"][value="servidor"]').checked;
  $('#janelaExportar').showModal();
}

async function exportarImportado(formatos) {
  const base = estado.importado;
  const dados = await api('/api/exportar-modpack-editado', {
    corpo: {
      projetoId: base.projeto.id,
      versaoId: base.versao.id,
      removidos: base.removidos,
      itens: [...estado.pack.values()].map((m) => ({
        fonte: m.fonte, projetoId: m.projetoId, versaoId: m.versaoId, tipo: m.tipo ?? 'mod',
      })),
      nome: $('#expNome').value.trim(),
      memoriaMb: Number($('#expMemoria').value),
      porta: Number($('#expPorta').value) || 25565,
      gerarServidor: formatos.includes('servidor'),
    },
  });
  const gerados = [];
  if (formatos.includes('mrpack')) {
    $('#confirmarExportar').textContent = `Baixando ${formatarTamanho(dados.origem.tamanho)}…`;
    const blob = await montarMrpackEditado(dados.origem.url, dados.origem.tamanho, dados.indice, dados.removidosEmbutidos);
    const nome = `${($('#expNome').value.trim() || 'modpack-editado').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'modpack-editado'}.mrpack`;
    gerados.push({ nome, url: URL.createObjectURL(blob), tamanho: blob.size });
  }
  if (formatos.includes('servidor')) {
    gerados.push({ nome: dados.servidor.nome, url: urlDoArquivo(dados.servidor.base64), tamanho: atob(dados.servidor.base64).length });
  }
  for (const url of urlsDeDownload) URL.revokeObjectURL(url);
  urlsDeDownload = gerados.map((g) => g.url);
  $('#nomePack').value = $('#expNome').value.trim();
  guardarRascunho();
  const caixa = $('#resultadoExportar');
  caixa.hidden = false;
  caixa.innerHTML = `<strong>Pronto. Modpack editado com ${dados.indice.files.length} arquivos de download.</strong>
    <p>Os ${base.configuracoes.length} arquivos de configuração e outros overrides originais foram preservados no .mrpack. ${dados.resumo.arquivos} arquivos entram no servidor; ${dados.resumo.excluidos} exclusivos do cliente ficam de fora.</p>
    <ul class="downloads">${gerados.map((g) => `<li><a class="botao" href="${g.url}" download="${esc(g.nome)}">Baixar ${esc(g.nome)}</a><span class="tamanho">${formatarTamanho(g.tamanho)}</span></li>`).join('')}</ul>
    ${formatos.includes('servidor') ? mostrarVerificacaoServidor(dados.resumo.verificacao) : ''}
    ${formatos.includes('servidor') ? '<p>Na VPS, rode o arquivo com <code>bash nome-do-arquivo.sh</code>. O script busca os arquivos originais para aplicar as configurações de servidor.</p>' : ''}`;
}

async function confirmarExportar() {
  const formatos = [...document.querySelectorAll('input[name="formato"]:checked')].map((i) => i.value);
  if (!formatos.length) {
    mostrarAviso('Escolha pelo menos um formato.', 'erro');
    return;
  }

  const botao = $('#confirmarExportar');
  botao.disabled = true;
  botao.textContent = 'Gerando…';

  try {
    if (estado.importado) {
      await exportarImportado(formatos);
      botao.textContent = 'Gerar de novo';
      botao.disabled = false;
      return;
    }
    const dados = await api('/api/exportar', {
      corpo: {
        loader: estado.loader,
        mc: estado.mc,
        loaderVersao: estado.loaderVersao,
        nome: $('#expNome').value.trim(),
        autor: $('#expAutor').value.trim(),
        memoriaMb: Number($('#expMemoria').value),
        porta: Number($('#expPorta').value) || 25565,
        formatos,
        itens: [...estado.pack.values()].map((m) => ({
          fonte: m.fonte,
          projetoId: m.projetoId,
          versaoId: m.versaoId,
          tipo: m.tipo ?? 'mod',
        })),
      },
    });

    $('#nomePack').value = $('#expNome').value.trim();
    const caixa = $('#resultadoExportar');
    caixa.hidden = false;

    const blocoServidor = dados.servidor
      ? `<p><strong>Servidor:</strong> ${dados.servidor.mods} mods.
         ${
           dados.servidor.somenteCliente.length
             ? `${dados.servidor.somenteCliente.length} ficaram de fora por serem só de cliente (${esc(dados.servidor.somenteCliente.join(', '))}) — eles derrubariam o servidor.`
             : ''
         }
         Mande o <strong>.sh</strong> para a VPS e rode <span class="caminho">bash nome-do-arquivo.sh</span>.</p>${mostrarVerificacaoServidor(dados.servidor.verificacao)}`
      : '';

    const tem = (tipo) => dados.gerados.some((g) => g.tipo === tipo);
    const comoUsar = [
      tem('bat')
        ? '<p><strong>Launcher oficial:</strong> mande o <strong>.bat</strong>. Dois cliques e o perfil aparece no launcher.</p>'
        : '',
      tem('mrpack')
        ? '<p><strong>Prism, MultiMC ou ATLauncher:</strong> mande o <strong>.mrpack</strong> e importe em Add Instance → Import. O .bat não funciona nesses launchers.</p>'
        : '',
    ].join('');

    // Os arquivos vêm na resposta. No site é a única forma de entregá-los; no PC
    // eles também ficam gravados em packs/, e o botão de abrir a pasta aparece.
    for (const url of urlsDeDownload) URL.revokeObjectURL(url);
    urlsDeDownload = dados.gerados.map((g) => urlDoArquivo(g.base64));

    caixa.innerHTML = `
      <strong>Pronto. ${dados.resumo.total} ${dados.resumo.total === 1 ? 'item' : 'itens'} no pack.</strong>
      ${dados.resumo.trocas ? `<p>${dados.resumo.trocas} ${dados.resumo.trocas === 1 ? 'versão foi ajustada' : 'versões foram ajustadas'} para os mods abrirem juntos.</p>` : ''}
      <ul class="downloads">${dados.gerados
        .map(
          (g, i) => `<li><a class="botao" href="${urlsDeDownload[i]}" download="${esc(g.arquivo)}">Baixar ${esc(g.arquivo)}</a>
            <span class="tamanho">${Math.max(1, Math.round(g.tamanho / 1024))} KB</span></li>`,
        )
        .join('')}</ul>
      ${comoUsar}
      ${blocoServidor}
      ${dados.pasta ? `<p class="caminho">Também salvos em ${esc(dados.pasta)}</p><button class="botao" id="abrirPasta">Abrir a pasta</button>` : ''}`;

    $('#abrirPasta')?.addEventListener('click', () => {
      api('/api/abrir-pasta', { corpo: { pasta: dados.pasta } }).catch(() =>
        mostrarAviso('Não consegui abrir a pasta. O caminho está aí em cima.', 'erro'),
      );
    });

    botao.textContent = 'Gerar de novo';
    botao.disabled = false;
  } catch (erro) {
    mostrarAviso(`Falhou ao gerar: ${erro.message}`, 'erro');
    botao.textContent = 'Gerar';
    botao.disabled = false;
  }
}

// --------------------------------------------------------- configurações

async function abrirConfig() {
  const config = await api('/api/config');
  const estadoCf = $('#estadoCf');

  // No site, a chave é de quem hospeda: o visitante só vê se ela está ligada.
  const local = config.configuravel;
  $('#ajudaChaveLocal').hidden = !local;
  $('#ajudaChaveNuvem').hidden = local;
  $('#chaveCf').hidden = !local;
  $('#notaCaminhoConfig').hidden = !local;
  $('#salvarChave').hidden = !local;
  $('#removerChave').hidden = !local;

  if (!local) {
    estadoCf.textContent = config.curseforgeAtiva
      ? 'CurseForge ligada neste site.'
      : config.curseforgeReprovada
        ? 'A chave da CurseForge deste site foi recusada. Só a Modrinth aparece na busca.'
        : 'CurseForge desligada neste site. Só a Modrinth aparece na busca.';
    estadoCf.dataset.tipo = config.curseforgeAtiva ? 'ok' : '';
    $('#janelaConfig').showModal();
    return;
  }

  $('#caminhoConfig').textContent = config.caminhoDaConfig;
  $('#chaveCf').value = '';
  $('#chaveCf').placeholder = config.curseforgeAtiva ? `chave salva (${config.curseforgeFinal})` : 'cole a chave aqui';
  if (config.curseforgeReprovada) {
    estadoCf.textContent =
      'A CurseForge está recusando a chave guardada. Gere uma nova em console.curseforge.com e cole aqui — chaves antigas às vezes são revogadas.';
    estadoCf.dataset.tipo = 'erro';
  } else if (config.curseforgeAtiva) {
    estadoCf.textContent = 'CurseForge ligada.';
    estadoCf.dataset.tipo = 'ok';
  } else {
    estadoCf.textContent = 'CurseForge desligada. Só a Modrinth aparece na busca.';
    estadoCf.dataset.tipo = '';
  }
  $('#janelaConfig').showModal();
}

async function salvarChave(chave) {
  const estadoCf = $('#estadoCf');
  estadoCf.textContent = 'Testando a chave…';
  estadoCf.dataset.tipo = '';
  try {
    const r = await api('/api/config/curseforge', { corpo: { chave } });
    estadoCf.textContent = r.curseforgeAtiva ? 'Chave aceita. A CurseForge já entra na busca.' : 'Chave removida.';
    estadoCf.dataset.tipo = 'ok';
    estado.inicio.curseforgeAtiva = r.curseforgeAtiva;
    reiniciarBusca();
  } catch (erro) {
    estadoCf.textContent = erro.message;
    estadoCf.dataset.tipo = 'erro';
  }
}

// --------------------------------------------------------------- eventos

function ligarEventos() {
  $('#tiposCatalogo').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-tipo]');
    if (!botao || botao.dataset.tipo === estado.tipo) return;
    estado.tipo = botao.dataset.tipo;
    estado.categorias.clear();
    for (const b of $('#tiposCatalogo').querySelectorAll('[data-tipo]')) {
      b.setAttribute('aria-pressed', String(b === botao));
    }
    const nomes = { mod: 'mods', shader: 'shaders', resourcepack: 'pacotes de recursos', modpack: 'modpacks' };
    $('#consulta').placeholder = `Buscar ${nomes[estado.tipo]}`;
    $('#consulta').setAttribute('aria-label', `Buscar ${nomes[estado.tipo]}`);
    desenharCategorias();
    reiniciarBusca();
  });

  $('#loaders').addEventListener('click', async (e) => {
    const botao = e.target.closest('.loader-opcao');
    if (!botao || estado.importado) return;
    escolherLoader(botao.dataset.loader);
    await carregarVersoesLoader();
    agendarResolucao();
    reiniciarBusca();
  });

  $('#versaoJogo').addEventListener('change', async () => {
    if (estado.importado) return;
    await trocarVersaoJogo();
    agendarResolucao();
  });

  $('#mostrarInstaveis').addEventListener('change', async (e) => {
    if (estado.importado) return;
    estado.mostrarInstaveis = e.target.checked;
    desenharVersoesJogo();
    await trocarVersaoJogo();
  });

  $('#versaoLoader').addEventListener('change', (e) => {
    if (estado.importado) return;
    estado.loaderVersao = e.target.value;
    atualizarBotaoExportar();
    atualizarResumoAlvo();
  });

  // Celular: a escolha de versão abre e fecha a partir da linha de resumo.
  $('#alternarAlvo').addEventListener('click', () => {
    const abrir = $('#topo').dataset.alvoAberto !== 'sim';
    $('#topo').dataset.alvoAberto = abrir ? 'sim' : '';
    $('#alternarAlvo').setAttribute('aria-expanded', String(abrir));
  });

  // Celular: a hotbar abre o pack; o fundo, o X e o Esc fecham.
  $('#abrirPack').addEventListener('click', abrirGaveta);
  $('#fecharPack').addEventListener('click', () => fecharGaveta());
  $('#fundoPack').addEventListener('click', () => fecharGaveta());
  document.addEventListener('keydown', (e) => {
    // Com uma janela aberta, o Esc é dela.
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) fecharGaveta();
  });
  // Se a tela crescer para o layout de computador, a gaveta deixa de existir.
  matchMedia('(min-width: 56.25rem)').addEventListener('change', (e) => {
    if (e.matches) fecharGaveta({ devolverFoco: false });
  });

  $('#consulta').addEventListener('input', (e) => {
    estado.consulta = e.target.value;
    clearTimeout(timerBusca);
    timerBusca = setTimeout(reiniciarBusca, 320);
  });

  $('#ordem').addEventListener('change', (e) => { estado.ordem = e.target.value; reiniciarBusca(); });
  $('#fontes').addEventListener('change', (e) => { estado.fontes = e.target.value; reiniciarBusca(); });

  $('#categorias').addEventListener('click', (e) => {
    const botao = e.target.closest('.categoria');
    if (!botao) return;
    const cat = botao.dataset.cat;
    if (estado.categorias.has(cat)) estado.categorias.delete(cat);
    else estado.categorias.add(cat);
    botao.setAttribute('aria-pressed', String(estado.categorias.has(cat)));
    reiniciarBusca();
  });

  $('#carregarMais').addEventListener('click', () => {
    estado.falhouPagina = false;
    pedirProximaPagina();
  });

  $('#resultados').addEventListener('scroll', checarRolagem, { passive: true });
  window.addEventListener('scroll', checarRolagem, { passive: true });
  window.addEventListener('resize', checarRolagem, { passive: true });

  // Um ouvinte para a página toda: a lista é redesenhada o tempo todo.
  document.addEventListener('click', (e) => {
    const adicionarBtn = e.target.closest('[data-adicionar]');
    if (adicionarBtn) return adicionar(adicionarBtn.dataset.adicionar);

    const removerBtn = e.target.closest('[data-remover]');
    if (removerBtn) return remover(removerBtn.dataset.remover);

    const detalheBtn = e.target.closest('[data-detalhe]');
    if (detalheBtn) return abrirDetalhe(detalheBtn.dataset.detalhe);

    const fixarBtn = e.target.closest('[data-fixar]');
    if (fixarBtn) return fixarVersao(fixarBtn.dataset.fixar, fixarBtn.dataset.versao);

    const baixarBtn = e.target.closest('[data-baixar-pack]');
    if (baixarBtn) return baixarModpack(baixarBtn.dataset.projeto, baixarBtn.dataset.baixarPack, baixarBtn);

    const editarBtn = e.target.closest('[data-editar-pack]');
    if (editarBtn) return editarModpack(editarBtn.dataset.projeto, editarBtn.dataset.editarPack, editarBtn);

    const removerOriginal = e.target.closest('[data-remover-original]');
    if (removerOriginal) return alterarOriginal(removerOriginal.dataset.removerOriginal, true);

    const restaurarOriginal = e.target.closest('[data-restaurar-original]');
    if (restaurarOriginal) return alterarOriginal(restaurarOriginal.dataset.restaurarOriginal, false);

    if (e.target.closest('[data-sair-edicao]')) return sairDaEdicao();

    if (e.target.closest('[data-abrir-config]')) return abrirConfig();
  });

  // A porta só interessa quando o instalador de servidor foi pedido.
  for (const caixa of document.querySelectorAll('input[name="formato"]')) {
    caixa.addEventListener('change', () => {
      $('#linhaPorta').hidden = !document.querySelector('input[name="formato"][value="servidor"]').checked;
    });
  }

  $('#abrirExportar').addEventListener('click', abrirExportar);
  $('#removerTodosMods').addEventListener('click', abrirConfirmacaoRemoverMods);
  $('#cancelarRemocaoMods').addEventListener('click', () => $('#janelaRemoverMods').close());
  $('#confirmarRemocaoMods').addEventListener('click', confirmarRemocaoMods);
  $('#cancelarSubstituicao').addEventListener('click', () => {
    substituicaoPendente = null;
    $('#janelaSubstituirPack').close();
  });
  $('#confirmarSubstituicao').addEventListener('click', () => {
    const pedido = substituicaoPendente;
    substituicaoPendente = null;
    $('#janelaSubstituirPack').close();
    if (pedido) editarModpack(pedido.projetoId, pedido.versaoId, pedido.botao, true);
  });
  $('#confirmarExportar').addEventListener('click', confirmarExportar);
  $('#fecharExportar').addEventListener('click', () => $('#janelaExportar').close());

  $('#abrirConfig').addEventListener('click', abrirConfig);
  $('#fecharConfig').addEventListener('click', () => $('#janelaConfig').close());
  $('#salvarChave').addEventListener('click', () => salvarChave($('#chaveCf').value.trim()));
  $('#removerChave').addEventListener('click', () => salvarChave(''));

  $('#nomePack').addEventListener('input', (e) => {
    $('#expNome').value = e.target.value;
    guardarRascunho();
  });
}

iniciar();
