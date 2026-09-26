// Gera o instalador de servidor a partir do mesmo pack que virou o .bat do cliente.
//
// A diferença que importa não é o sistema operacional: é que um servidor não
// pode receber mods de cliente. Sodium, Iris, minimapa, shader — tudo isso
// pode exigir classes de cliente no boot. Conferimos rótulos e descritores dos
// JARs e auditamos as dependências que permanecem no servidor.

import { readFile } from 'node:fs/promises';
import { planoDeInstalacaoServidor, LOADERS } from './loaders.mjs';
import { auditarPack, exigirServidorValido, somenteCliente, selecionarModsServidor } from './auditoria.mjs';
import { criarVerificador, textoVerificacao } from './verificador-servidor.mjs';
import { gerarSlug, nomeDeArquivoSeguro } from './exportar.mjs';

const MOLDE_SH = new URL('./instalador-servidor.sh', import.meta.url);

/** Escapa para dentro de uma string com aspas duplas no shell. */
const aspasShell = (valor) =>
  String(valor ?? '').replace(/[\\$`"]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');

export function ehSomenteCliente(mod) {
  return somenteCliente({ ...mod, meta: mod.meta ?? mod.metadados });
}

export function separarPorLado(arquivos) {
  const entradas = arquivos.map((m) => ({ ...m, meta: m.meta ?? m.metadados }));
  return selecionarModsServidor(entradas);
}

export async function gerarInstaladorServidor(plano, opcoes) {
  const { nome, autor = '', memoriaMb = 4096, loaderVersao, porta = 25565 } = opcoes;
  const { loader, mc } = plano.alvo;

  const { servidor, somenteCliente } = separarPorLado(plano.arquivos);
  const verificacao = auditarPack(servidor.map((m) => ({ ...m, meta: m.meta ?? m.metadados })), { lado: 'server', loader, mc, loaderVersao });
  exigirServidorValido(verificacao);
  const instalador = await planoDeInstalacaoServidor(loader, mc, loaderVersao);
  const nomeLoader = LOADERS.find((l) => l.id === loader)?.nome ?? loader;

  const manuais = servidor.filter((m) => !m.distribuicaoLiberada || !m.arquivo?.url);

  const linhasMods = servidor
    .map((m) => {
      const campos = [
        String(m.nome).replace(/\|/g, '/'),
        m.arquivo?.nome ?? '',
        m.arquivo?.sha1 ?? '',
        m.distribuicaoLiberada ? m.arquivo?.url ?? '' : '',
      ].map(aspasShell);
      return `  "${campos.join('|')}"`;
    })
    .join('\n');

  const linhasCliente = somenteCliente
    .map((m) => `  "${aspasShell(m.nome)}"`)
    .join('\n');

  const molde = await readFile(MOLDE_SH, 'utf8');

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
    TOTAL_MODS: String(servidor.length),
    MODS: linhasMods,
    SOMENTE_CLIENTE: linhasCliente,
    JAVA_MINIMO: String(verificacao.javaMinimo),
    JAVA_PERMITIDOS: verificacao.javaPermitidos.join(' '),
    VERIFICACAO: textoVerificacao(verificacao),
    VERIFICADOR: criarVerificador(),
  };

  let script = molde;
  for (const [chave, valor] of Object.entries(substituicoes)) {
    script = script.split(`@@${chave}@@`).join(valor);
  }

  return {
    nomeArquivo: `instalar-servidor-${gerarSlug(nome)}.sh`,
    // Fim de linha Unix, sem BOM: um \r faria o shell reclamar de "bad interpreter".
    conteudo: Buffer.from(script.replace(/\r\n/g, '\n'), 'utf8'),
    contagem: servidor.length,
    verificacao,
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
