// Gera o instalador de servidor a partir do mesmo pack que virou o .bat do cliente.
//
// A diferença que importa não é o sistema operacional: é que um servidor não
// pode receber mods de cliente. Sodium, Iris, minimapa, shader — tudo isso
// derruba o servidor no boot. Quem decide é o campo server_side da Modrinth.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planoDeInstalacaoServidor, LOADERS } from './loaders.mjs';
import { MODS_DO_AMBIENTE } from './jarmeta.mjs';
import { gerarSlug, nomeDeArquivoSeguro } from './exportar.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/** Escapa para dentro de uma string com aspas duplas no shell. */
const aspasShell = (valor) =>
  String(valor ?? '').replace(/[\\$`"]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');

/** Um mod que o servidor não pode carregar, segundo o rótulo da loja. */
export function ehSomenteCliente(mod) {
  return mod.ladoServidor === 'unsupported';
}

/**
 * Separa o pack em "vai para o servidor" e "é só do cliente".
 *
 * O rótulo da loja é o ponto de partida, mas ele sozinho não basta: esses campos
 * são preenchidos à mão e erram com frequência. Por isso, depois de excluir pelo
 * rótulo, devolvemos ao servidor qualquer mod do qual um mod que ficou ainda
 * depende — tirar uma dependência é o jeito mais garantido de o servidor não
 * subir. Mods da CurseForge não trazem essa informação e entram por padrão.
 */
export function separarPorLado(arquivos) {
  const candidatosAFicar = arquivos.filter((m) => !ehSomenteCliente(m));
  const excluidos = arquivos.filter(ehSomenteCliente);

  // Reincorpora só o que faz falta de verdade, até estabilizar — uma dependência
  // trazida de volta pode, por sua vez, exigir outra.
  //
  // O teste é "esta exigência continua sem ninguém que a atenda?", e não apenas
  // "alguém exige isto". A diferença importa: bibliotecas embutem umas às outras,
  // e o Sodium carrega submódulos do Fabric API dentro do próprio jar. Pela regra
  // frouxa, um mod de servidor pedindo um desses submódulos arrastaria o Sodium
  // para dentro do servidor — e Sodium em servidor dedicado não sobe.
  const ficar = new Set(candidatosAFicar);
  let mexeu = true;
  while (mexeu) {
    mexeu = false;

    const jaSuprido = new Set();
    for (const mod of ficar) {
      if (mod.modId) jaSuprido.add(mod.modId);
      for (const fornecido of mod.fornece ?? []) jaSuprido.add(fornecido);
    }

    const semDono = new Set();
    for (const mod of ficar) {
      for (const dep of mod.dependeDe ?? []) {
        if (!jaSuprido.has(dep) && !MODS_DO_AMBIENTE.has(dep)) semDono.add(dep);
      }
    }
    if (!semDono.size) break;

    for (const mod of excluidos) {
      if (ficar.has(mod)) continue;
      const identidades = [mod.modId, ...(mod.fornece ?? [])].filter(Boolean);
      if (identidades.some((id) => semDono.has(id))) {
        ficar.add(mod);
        mexeu = true;
      }
    }
  }

  return {
    servidor: arquivos.filter((m) => ficar.has(m)),
    somenteCliente: arquivos.filter((m) => !ficar.has(m)),
  };
}

export async function gerarInstaladorServidor(plano, opcoes) {
  const { nome, autor = '', memoriaMb = 4096, loaderVersao, porta = 25565 } = opcoes;
  const { loader, mc } = plano.alvo;

  const instalador = await planoDeInstalacaoServidor(loader, mc, loaderVersao);
  const nomeLoader = LOADERS.find((l) => l.id === loader)?.nome ?? loader;

  const { servidor, somenteCliente } = separarPorLado(plano.arquivos);
  const baixaveis = servidor.filter((m) => m.distribuicaoLiberada && m.arquivo?.url);
  const manuais = servidor.filter((m) => !m.distribuicaoLiberada || !m.arquivo?.url);

  const linhasMods = baixaveis
    .map((m) => {
      const campos = [
        String(m.nome).replace(/\|/g, '/'),
        m.arquivo.nome,
        m.arquivo.sha1 ?? '',
        m.arquivo.url,
      ].map(aspasShell);
      return `  "${campos.join('|')}"`;
    })
    .join('\n');

  const linhasCliente = somenteCliente
    .map((m) => `  "${aspasShell(m.nome)}"`)
    .join('\n');

  const molde = await readFile(path.join(AQUI, 'instalador-servidor.sh'), 'utf8');

  const substituicoes = {
    PACK_NOME: aspasShell(nome),
    PACK_SLUG: gerarSlug(nome),
    PACK_AUTOR: aspasShell(autor),
    MC_VERSAO: aspasShell(mc),
    LOADER_NOME: aspasShell(nomeLoader),
    LOADER_VERSAO: aspasShell(loaderVersao),
    LOADER_URL: aspasShell(instalador.instaladorUrl),
    LOADER_JAR: aspasShell(instalador.instaladorArquivo),
    LOADER_LANCADOR: aspasShell(instalador.lancador ?? ''),
    LOADER_ARGS: instalador.argumentos.map((a) => `"${aspasShell(a)}"`).join(' '),
    MEMORIA_MB: String(memoriaMb),
    PORTA: String(porta),
    TOTAL_MODS: String(baixaveis.length),
    MODS: linhasMods,
    SOMENTE_CLIENTE: linhasCliente,
  };

  let script = molde;
  for (const [chave, valor] of Object.entries(substituicoes)) {
    script = script.split(`@@${chave}@@`).join(valor);
  }

  return {
    nomeArquivo: `instalar-servidor-${gerarSlug(nome)}.sh`,
    // Fim de linha Unix, sem BOM: um \r faria o shell reclamar de "bad interpreter".
    conteudo: Buffer.from(script.replace(/\r\n/g, '\n'), 'utf8'),
    contagem: baixaveis.length,
    somenteCliente: somenteCliente.map((m) => m.nome),
    manuais: manuais.map((m) => ({ nome: m.nome, pagina: m.paginaDoArquivo ?? m.pagina })),
  };
}

/**
 * Atalho para quem roda o servidor no Windows: um .bat que chama o mesmo
 * instalador de cliente, mas apontado para uma pasta de servidor.
 * Mantemos separado porque o caminho comum é Linux.
 */
export async function gerarAjudaWindows(plano, opcoes) {
  const { servidor, somenteCliente } = separarPorLado(plano.arquivos);
  const linhas = [
    `Servidor: ${opcoes.nome}`,
    `Minecraft ${plano.alvo.mc} - ${plano.alvo.loader} ${opcoes.loaderVersao}`,
    '',
    `Mods que vao para o servidor (${servidor.length}):`,
    ...servidor.map((m) => `  ${m.nome}  ${m.versaoNumero}`),
    '',
    `Ficaram de fora por serem so de cliente (${somenteCliente.length}):`,
    ...somenteCliente.map((m) => `  ${m.nome}`),
    '',
    'O instalador .sh e para Linux, que e o caso da maioria das VPS.',
    'Num servidor Windows, crie a pasta, rode o instalador oficial do modloader',
    'em modo servidor e copie os jars da lista acima para a pasta mods.',
  ];
  return {
    nomeArquivo: `${nomeDeArquivoSeguro(opcoes.nome)} - servidor.txt`,
    conteudo: Buffer.from(linhas.join('\r\n'), 'utf8'),
  };
}
