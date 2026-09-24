// ModpackForge — interface.
// O servidor guarda as chaves e o cache; aqui só desenhamos e reagimos.
// As regras de conflito vêm do mesmo módulo que o resolver usa no servidor,
// então o bloqueio aparece na hora, sem ida e volta.

import { checarCandidato } from '/compartilhado/conflitos.mjs';

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
  categorias: new Set(),
  pagina: 0,
  resultados: [],
  temMais: false,
  buscando: false,
  falhouPagina: false,
  pack: new Map(), // chave -> { fonte, projetoId, nome, slug, icone, versaoId }
  plano: null,
  resolvendo: false,
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
  b >= 1_073_741_824 ? `${(b / 1_073_741_824).toFixed(1)} GB` : `${Math.round(b / 1_048_576)} MB`;

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
    if (rascunho.nome) $('#nomePack').value = rascunho.nome;
    mostrarAviso(`Voltei com o seu pack de antes: ${rascunho.pack.length} mods.`);
  }

  await trocarVersaoJogo();
  ligarEventos();
  if (estado.pack.size) agendarResolucao();
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
  $('#categorias').innerHTML = estado.inicio.categorias
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
      ? `${estado.resultados.length} mods · acabou a lista`
      : '';
    sentinela.dataset.estado = 'fim';
  }
}

async function buscar() {
  if (!estado.loader || !estado.mc) return;
  const seletores = ['#consulta', '#ordem', '#fontes'];
  for (const s of seletores) $(s).disabled = false;

  estado.buscando = true;
  estado.falhouPagina = false;
  if (estado.pagina === 0) {
    $('#resultados').innerHTML = '<li class="carregando">procurando…</li>';
  }
  atualizarSentinela();

  const params = new URLSearchParams({
    q: estado.consulta,
    loader: estado.loader,
    mc: estado.mc,
    ordem: estado.ordem,
    pagina: String(estado.pagina),
  });
  if (estado.fontes !== 'ambas') params.set('fontes', estado.fontes);
  if (estado.categorias.size) params.set('categorias', [...estado.categorias].join(','));

  try {
    const dados = await api(`/api/buscar?${params}`);

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
    estado.falhouPagina = true;
    if (estado.pagina === 0) {
      $('#resultados').innerHTML = `<li class="carregando">${esc(erro.message)}</li>`;
    } else {
      estado.pagina--; // a página não entrou; tentar de novo repete esta, não a seguinte
      mostrarAviso(`Não consegui carregar mais mods: ${erro.message}`, 'erro');
    }
    desenharResultados();
  } finally {
    estado.buscando = false;
    atualizarSentinela();
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
  if (estado.plano?.arquivos?.length) return estado.plano.arquivos;
  return [...estado.pack.values()].map((m) => ({ ...m, incompativeis: [] }));
}

function desenharResultados() {
  const lista = $('#resultados');
  if (!estado.resultados.length) {
    lista.innerHTML = `<li class="carregando">${
      estado.consulta ? 'Nada com esse nome para ' + esc(estado.loader) + ' ' + esc(estado.mc) + '.' : 'Nenhum mod para essa combinação.'
    }</li>`;
    $('#carregarMais').hidden = true;
    $('.rodape-lista').hidden = true;
    return;
  }

  const jaNoPack = escolhidosParaChecagem();

  lista.innerHTML = estado.resultados
    .map((mod) => {
      const chave = chaveDe(mod.fonte, mod.id);
      const dentro = estado.pack.has(chave);
      const choques = dentro ? [] : checarCandidato(mod, jaNoPack);
      const bloqueio = choques.find((c) => c.severidade === 'bloqueio');
      const aviso = choques.find((c) => c.severidade === 'aviso');

      const estadoLinha = dentro ? 'no-pack' : bloqueio ? 'bloqueado' : 'livre';

      let acao;
      if (dentro) {
        acao = `<button class="botao" data-remover="${esc(chave)}">Tirar</button>`;
      } else if (bloqueio) {
        acao = `<button class="botao" disabled>Bloqueado</button>
                <span class="motivo-bloqueio">${esc(bloqueio.titulo)}: ${esc(bloqueio.outro.nome)}</span>`;
      } else {
        acao = `<button class="botao botao-forte" data-adicionar="${esc(chave)}">Adicionar</button>` +
          (aviso ? `<span class="motivo-bloqueio motivo-aviso">${esc(aviso.titulo)}</span>` : '');
      }

      const icone = mod.icone
        ? `<img src="${esc(mod.icone)}" alt="" loading="lazy">`
        : `<span class="mod-slot-vazio">${esc((mod.nome || '?')[0].toUpperCase())}</span>`;

      return `<li class="mod" data-estado="${estadoLinha}" data-chave="${esc(chave)}">
        <div class="mod-slot">${icone}</div>
        <div class="mod-info">
          <div class="mod-titulo">
            <button class="mod-nome" data-detalhe="${esc(chave)}">${esc(mod.nome)}</button>
            <span class="mod-autor">${esc(mod.autor ?? '')}</span>
          </div>
          <p class="mod-resumo">${esc(mod.resumo)}</p>
          <div class="mod-meta">
            <span class="loja loja-${esc(mod.fonte)}">${mod.fonte === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>
            <span class="numero">${formatarNumero(mod.downloads)} downloads</span>
            ${mod.categorias.slice(0, 3).map((c) => `<span>${esc(c)}</span>`).join('')}
          </div>
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
  if (!mod || estado.pack.has(chave)) return;
  estado.pack.set(chave, {
    fonte: mod.fonte,
    projetoId: mod.id,
    nome: mod.nome,
    slug: mod.slug,
    icone: mod.icone,
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

let timerResolucao;
function agendarResolucao() {
  guardarRascunho();
  clearTimeout(timerResolucao);
  if (!estado.pack.size) {
    estado.plano = null;
    desenharPack();
    return;
  }
  estado.resolvendo = true;
  desenharPack();
  timerResolucao = setTimeout(resolverPack, 220);
}

async function resolverPack() {
  const itens = [...estado.pack.values()].map((m) => ({
    fonte: m.fonte,
    projetoId: m.projetoId,
    versaoId: m.versaoId,
  }));
  try {
    estado.plano = await api('/api/resolver', {
      corpo: { loader: estado.loader, mc: estado.mc, itens },
    });
    for (const erro of estado.plano.erros ?? []) {
      if (erro.codigo === 'CF_SEM_CHAVE') mostrarAviso('Configure a chave da CurseForge para resolver esses mods.', 'erro');
    }
  } catch (erro) {
    mostrarAviso(`Não consegui montar o pack: ${erro.message}`, 'erro');
  } finally {
    estado.resolvendo = false;
    desenharPack();
    desenharResultados();
  }
}

function desenharPack() {
  const corpo = $('#packCorpo');
  const alertas = $('#packAlertas');

  if (!estado.pack.size) {
    corpo.innerHTML = `<div class="vazio">
      <div class="vazio-slot" aria-hidden="true"></div>
      <p>Os mods que você escolher aparecem aqui, junto com tudo que eles exigem.</p>
    </div>`;
    alertas.innerHTML = '';
    $('#packConta').textContent = 'Nenhum mod ainda';
    $('#packPeso').textContent = '';
    atualizarBotaoExportar();
    return;
  }

  const plano = estado.plano;
  if (!plano) {
    corpo.innerHTML = '<p class="carregando">resolvendo dependências…</p>';
    $('#packConta').textContent = `${estado.pack.size} escolhidos`;
    atualizarBotaoExportar();
    return;
  }

  const escolhidos = plano.arquivos.filter((a) => a.origem === 'escolhido');
  const dependencias = plano.arquivos.filter((a) => a.origem === 'dependencia');

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
      ${a.origem === 'escolhido' ? `<button class="pack-remover" data-remover="${esc(a.chave)}" title="Tirar do pack" aria-label="Tirar ${esc(a.nome)} do pack">✕</button>` : '<span></span>'}
    </li>`;
  };

  corpo.innerHTML =
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
  if (plano.manuais.length) {
    blocos.push(`<div class="alerta alerta-aviso">
      <strong>${plano.manuais.length} ${plano.manuais.length === 1 ? 'mod precisa' : 'mods precisam'} de download manual</strong> —
      o autor desativou o download automático na CurseForge. O instalador vai abrir as páginas certas.
    </div>`);
  }
  alertas.innerHTML = blocos.join('');

  $('#packConta').textContent =
    `${plano.resumo.escolhidos} escolhidos · ${plano.resumo.dependencias} dependências · ${plano.resumo.total} arquivos`;
  $('#packPeso').textContent = plano.resumo.tamanho ? `${formatarTamanho(plano.resumo.tamanho)} para baixar` : '';

  atualizarBotaoExportar();
}

function atualizarBotaoExportar() {
  const bloqueios = estado.plano?.resumo?.bloqueios ?? 0;
  const pronto = estado.pack.size > 0 && estado.loaderVersao && !estado.resolvendo && bloqueios === 0;
  const botao = $('#abrirExportar');
  botao.disabled = !pronto;
  botao.textContent = bloqueios > 0 ? 'Resolva os conflitos primeiro' : 'Gerar instalador';
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
      `/api/projeto?fonte=${encodeURIComponent(mod.fonte)}&id=${encodeURIComponent(mod.id)}&loader=${encodeURIComponent(estado.loader)}&mc=${encodeURIComponent(estado.mc)}`,
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
        <p class="pack-secao">Versões para ${esc(estado.loader)} ${esc(estado.mc)} (${versoes.length})</p>
        <div class="detalhe-versoes">
          ${
            versoes.length
              ? versoes
                  .slice(0, 25)
                  .map(
                    (v) => `<div class="detalhe-versao">
                      <span>${esc(v.numero)}<br><span class="numero">${esc(v.arquivo?.nome ?? '')}</span></span>
                      <span class="canal canal-${esc(v.canal)}">${esc(v.canal)}</span>
                      <button class="botao" data-fixar="${esc(chave)}" data-versao="${esc(v.id)}">${
                        fixada === v.id ? 'fixada' : 'usar esta'
                      }</button>
                    </div>`,
                  )
                  .join('')
              : '<p class="nota">Nenhuma versão compatível.</p>'
          }
        </div>
        ${fixada ? `<button class="botao" data-fixar="${esc(chave)}" data-versao="">Voltar para a mais nova</button>` : ''}
      </div>`;
  } catch (erro) {
    $('#detalheCorpo').innerHTML = `<p class="carregando">${esc(erro.message)}</p>`;
  }
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
  $('#janelaExportar').showModal();
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
         Mande o <strong>.sh</strong> para a VPS e rode <span class="caminho">bash nome-do-arquivo.sh</span>.</p>`
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
      <strong>Pronto. ${dados.resumo.total} ${dados.resumo.total === 1 ? 'mod' : 'mods'} no pack.</strong>
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
  $('#loaders').addEventListener('click', async (e) => {
    const botao = e.target.closest('.loader-opcao');
    if (!botao) return;
    escolherLoader(botao.dataset.loader);
    await carregarVersoesLoader();
    agendarResolucao();
    reiniciarBusca();
  });

  $('#versaoJogo').addEventListener('change', async () => {
    await trocarVersaoJogo();
    agendarResolucao();
  });

  $('#mostrarInstaveis').addEventListener('change', async (e) => {
    estado.mostrarInstaveis = e.target.checked;
    desenharVersoesJogo();
    await trocarVersaoJogo();
  });

  $('#versaoLoader').addEventListener('change', (e) => {
    estado.loaderVersao = e.target.value;
    atualizarBotaoExportar();
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

    if (e.target.closest('[data-abrir-config]')) return abrirConfig();
  });

  // A porta só interessa quando o instalador de servidor foi pedido.
  for (const caixa of document.querySelectorAll('input[name="formato"]')) {
    caixa.addEventListener('change', () => {
      $('#linhaPorta').hidden = !document.querySelector('input[name="formato"][value="servidor"]').checked;
    });
  }

  $('#abrirExportar').addEventListener('click', abrirExportar);
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
