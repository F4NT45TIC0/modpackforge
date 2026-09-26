import { comparar, satisfaz, descreverExigencia } from './versoes.mjs';
import { MODS_DO_AMBIENTE } from './jarmeta.mjs';

export function javaDoMinecraft(mc) {
  return comparar(mc, '26.1') >= 0 ? 25 : comparar(mc, '1.20.5') >= 0 ? 21 : comparar(mc, '1.18') >= 0 ? 17 : comparar(mc, '1.17') >= 0 ? 16 : 8;
}

export function metadadosDoLado(meta, lado) {
  if (!meta || (meta.ambiente === 'client' && lado === 'server') || (meta.ambiente === 'server' && lado === 'client')) return [];
  return [meta, ...(meta.embutidos ?? []).flatMap((m) => metadadosDoLado(m, lado))];
}

export function somenteCliente(registro) {
  return ['shader', 'resourcepack'].includes(registro.tipo) || registro.meta?.ambiente === 'client' ||
    (!registro.meta || registro.meta.ambiente !== 'server') && registro.ladoServidor === 'unsupported';
}

/** Uma biblioteca rotulada como cliente pode declarar suporte aos dois lados.
 * Recuperamos somente identidades do lado servidor; aliases de JARs de cliente
 * embutidos nunca podem trazer o arquivo pai de volta. */
export function selecionarModsServidor(registros) {
  const ficar = new Set(registros.filter((r) => !somenteCliente(r)));
  const recuperados = [];
  let mudou = true;
  while (mudou) {
    mudou = false;
    const fornecidos = new Set([...ficar].flatMap((r) => metadadosDoLado(r.meta, 'server')
      .flatMap((m) => [m.modId, ...(m.forneceDeclarados ?? m.fornece ?? [])])));
    const exigidos = new Set([...ficar].flatMap((r) => metadadosDoLado(r.meta, 'server')
      .flatMap((m) => Object.keys(m.dependeServidor ?? m.depende ?? {}))).filter((id) => !fornecidos.has(id)));
    for (const r of registros) {
      const bibliotecaSemLado = r.meta?.ambiente === 'unknown' && ['forge', 'neoforge'].includes(r.meta.tipo);
      if (ficar.has(r) || (r.meta?.ambiente !== '*' && !bibliotecaSemLado) || ['shader', 'resourcepack'].includes(r.tipo)) continue;
      const ids = metadadosDoLado(r.meta, 'server').flatMap((m) => [m.modId, ...(m.forneceDeclarados ?? [])]);
      if (ids.some((id) => exigidos.has(id))) {
        ficar.add(r); recuperados.push(r); mudou = true;
      }
    }
  }
  return { servidor: registros.filter((r) => ficar.has(r)), somenteCliente: registros.filter((r) => !ficar.has(r)), recuperados };
}

/** Auditoria de declaracoes. Executar o servidor continua sendo a prova de boot. */
export function auditarPack(registros, { lado = 'server', loader, mc, loaderVersao } = {}) {
  const bloqueios = [], avisos = [], indice = new Map(), principais = new Map(), destinos = new Map();
  let javaMinimo = javaDoMinecraft(mc ?? '1.21');
  const faixasJava = [];
  const mods = registros.filter((r) => !['shader', 'resourcepack'].includes(r.tipo));
  const adicionar = (lista, r, texto, tipo) => lista.push({ tipo, nome: r.nome, chave: r.chave, texto });
  for (const r of mods) {
    const destino = (r.caminho ?? (r.arquivo?.nome ? `mods/${r.arquivo.nome}` : null))?.toLowerCase();
    if (destino) {
      if (destinos.has(destino)) adicionar(bloqueios, r, `${r.nome} e ${destinos.get(destino).nome} usam o mesmo caminho ${destino}.`, 'arquivo-duplicado');
      else destinos.set(destino, r);
    }
    if (!r.meta) { adicionar(avisos, r, `${r.nome}: metadados do JAR indisponiveis; verificacao incompleta.`, 'nao-verificado'); continue; }
    if (lado === 'server' && r.meta.ambiente === 'unknown' && (!r.ladoServidor || ['unknown', 'unsupported'].includes(r.ladoServidor))) {
      adicionar(avisos, r, `${r.nome}: o descritor do JAR nao confirma suporte a servidor dedicado. Confira no teste de boot.`, 'lado-nao-confirmado');
    }
    if (r.meta.incompleto) adicionar(avisos, r, `${r.nome}: nem todas as bibliotecas ou regras puderam ser lidas.`, 'nao-verificado');
    if ((lado === 'server' && r.meta.ambiente === 'client') || (lado === 'client' && r.meta.ambiente === 'server')) {
      adicionar(bloqueios, r, `${r.nome} so pode ser carregado no ${r.meta.ambiente === 'client' ? 'cliente' : 'servidor'}.`, 'lado-incorreto');
    }
    for (const id of r.meta.idsPrincipais ?? [r.meta.modId]) {
      if (principais.has(id)) adicionar(bloqueios, r, `${r.nome} duplica o mod ID "${id}" de ${principais.get(id).nome}. Mantenha apenas um arquivo.`, 'duplicado');
      else principais.set(id, r);
    }
    for (const m of metadadosDoLado(r.meta, lado)) {
      for (const id of [m.modId, ...(m.forneceDeclarados ?? m.fornece ?? [])]) {
        const versao = m.versaoDe?.[id] ?? m.versao;
        const existente = indice.get(id);
        if (!existente || (m.modId === id && existente.alias) || (!principais.has(id) && comparar(versao, existente.versao) > 0)) {
          indice.set(id, { r, meta: m, versao, alias: m.modId !== id });
        }
      }
    }
  }
  // IDs principais prevalecem sobre alternativas embutidas em outros JARs.
  for (const [id, r] of principais) indice.set(id, { r, meta: r.meta, versao: r.meta.versaoDe?.[id] ?? r.meta.versao });
  const ambiente = { minecraft: mc, java: null, [loader]: loaderVersao };
  if (!loader) for (const id of ['fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge', 'mcp', 'fml']) ambiente[id] = null;
  if (loader === 'fabric' || loader === 'quilt') {
    ambiente.fabricloader = loader === 'fabric' ? loaderVersao : null;
    ambiente['fabric-loader'] = ambiente.fabricloader;
    ambiente.quilt_loader = loader === 'quilt' ? loaderVersao : null;
  }
  if (loader === 'neoforge' && mc === '1.20.1') ambiente.forge = null;
  // JARs aninhados sao candidatos opcionais do loader. Somente os exigidos
  // transitivamente podem impor requisitos ao pack. C2ME, por exemplo, embute
  // uma otimizacao de Java 25 que pode ficar desativada num servidor Java 21.
  const ativos = new Set(mods.flatMap((r) => metadadosDoLado(r.meta, lado).slice(0, 1)));
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const m of ativos) {
      const deps = m.regrasDependencia
        ? m.regrasDependencia.filter((d) => d.obrigatoria && (d.lado === 'BOTH' || d.lado === lado.toUpperCase())).map((d) => d.id)
        : Object.keys((lado === 'server' ? m.dependeServidor : m.dependeCliente) ?? m.depende ?? {});
      for (const id of deps) {
        const dentro = indice.get(id)?.meta;
        if (dentro && !ativos.has(dentro)) { ativos.add(dentro); mudou = true; }
      }
    }
  }
  const incompleto = mods.some((r) => !r.meta || r.meta.incompleto);
  for (const r of mods) for (const m of metadadosDoLado(r.meta, lado)) {
    if (!ativos.has(m)) continue;
    for (const faixa of m.exigenciasJava ?? []) faixasJava.push({ r, faixa, dialeto: 'maven' });
    const dependencias = lado === 'server' ? m.dependeServidor ?? m.depende : m.dependeCliente ?? m.depende;
    const regras = m.regrasDependencia
      ? m.regrasDependencia.filter((d) => d.lado === 'BOTH' || d.lado === lado.toUpperCase())
      : Object.entries(dependencias ?? {}).map(([id, faixa]) => ({ id, faixa, obrigatoria: true }));
    for (const { id, faixa, obrigatoria } of regras) {
      if (!obrigatoria && !indice.has(id) && !MODS_DO_AMBIENTE.has(id)) continue;
      if (id === 'java') {
        faixasJava.push({ r, faixa, dialeto: m.dialeto });
        continue;
      }
      if (MODS_DO_AMBIENTE.has(id)) {
        if (!(id in ambiente)) {
          // MCP/FML sao internos ao Forge; o Fabric nao fornece NeoForge etc.
          if (['mcp', 'fml'].includes(id) && ['forge', 'neoforge'].includes(loader)) continue;
          if (id === 'quilt_base') continue;
          adicionar(bloqueios, r, `${r.nome} exige o loader ${id}, mas o pack usa ${loader}.`, 'loader-incorreto');
        } else if (ambiente[id] && !satisfaz(ambiente[id], faixa, m.dialeto)) {
          adicionar(bloqueios, r, `${r.nome} exige ${id} ${descreverExigencia(faixa)}; o pack usa ${ambiente[id]}.`, 'ambiente-incompativel');
        } else if (!ambiente[id] && String(faixa) !== '*') {
          adicionar(avisos, r, `${r.nome}: falta a versao de ${id} para conferir ${descreverExigencia(faixa)}.`, 'nao-verificado');
        }
        continue;
      }
      if (id === 'mixinextras' && loader === 'fabric' && loaderVersao && comparar(loaderVersao, '0.15.0') >= 0 && !indice.has(id)) {
        adicionar(avisos, r, `${r.nome}: MixinExtras fornecido pelo loader; confira a faixa ${descreverExigencia(faixa)} no teste de inicializacao.`, 'nao-verificado');
        continue;
      }
      const dep = indice.get(id);
      if (!dep) adicionar(incompleto ? avisos : bloqueios, r,
        `${r.nome} precisa de "${id}" ${descreverExigencia(faixa)}, que nao foi identificado nos arquivos ${lado === 'server' ? 'do servidor' : 'do cliente'}.` + (incompleto ? ' Ha JARs sem leitura completa; confirme no teste de inicializacao.' : ''), 'dependencia-ausente');
      else if (!dep.versao && String(faixa) !== '*') adicionar(avisos, r, `${r.nome}: versao de ${id} desconhecida.`, 'nao-verificado');
      else if (!satisfaz(dep.versao, faixa, m.dialeto)) adicionar(bloqueios, r,
        `${r.nome} exige ${id} ${descreverExigencia(faixa)}, mas encontrou ${dep.versao}.`, 'versao-incompativel');
    }
    const quebras = lado === 'server' ? m.quebraServidor ?? m.quebra : m.quebraCliente ?? m.quebra;
    for (const [id, faixa] of Object.entries(quebras ?? {})) {
      const dep = indice.get(id);
      if (dep && dep.r !== r && dep.versao && satisfaz(dep.versao, faixa, m.dialeto)) {
        adicionar(bloqueios, r, `${r.nome} declara incompatibilidade com ${dep.r.nome} ${dep.versao}.`, 'incompativel-declarado');
      }
    }
  }
  const javaPermitidos = Array.from({ length: 64 }, (_, i) => javaMinimo + i)
    .filter((v) => faixasJava.every((f) => satisfaz(String(v), f.faixa, f.dialeto)));
  const javaCompativel = javaPermitidos[0];
  if (javaCompativel) javaMinimo = javaCompativel;
  else {
    const restritas = faixasJava.filter((f) => Array.from({ length: 64 }, (_, i) => javaMinimo + i).some((v) => !satisfaz(String(v), f.faixa, f.dialeto)));
    adicionar(bloqueios, restritas[0]?.r ?? mods[0], `As faixas de Java nao tem uma versao em comum: ${restritas.map((f) => `${f.r.nome} exige ${descreverExigencia(f.faixa)}`).join('; ')}. Minecraft ${mc} exige Java ${javaMinimo} ou superior.`, 'java-incompativel');
  }
  return { status: bloqueios.length ? 'bloqueado' : avisos.length ? 'incompleto' : 'declaracoes-conferidas',
    total: mods.length, verificados: mods.filter((r) => r.meta && !r.meta.incompleto).length, javaMinimo, javaPermitidos, bloqueios, avisos };
}

export function exigirServidorValido(relatorio) {
  if (relatorio.bloqueios.length) throw Object.assign(new Error('Servidor bloqueado pela verificacao: ' + relatorio.bloqueios.slice(0, 8).map((p) => p.texto).join(' ')), { status: 409 });
}
