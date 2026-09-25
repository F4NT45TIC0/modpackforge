// Transforma o plano resolvido nos arquivos que você manda para os amigos.
//
// .bat     — auto-contido. O amigo dá dois cliques e pronto. Só precisa do Windows.
// .mrpack  — formato padrão da Modrinth, para quem usa Prism, ATLauncher ou o app da Modrinth.

import { readFile } from 'node:fs/promises';
import { planoDeInstalacao, LOADERS } from './loaders.mjs';
import { montarZip } from './zip.mjs';

// Os moldes são lidos por URL relativa ao módulo: é a forma que o empacotador da
// Vercel reconhece para incluir o arquivo junto da função.
const MOLDE_BAT = new URL('./instalador.ps1', import.meta.url);

export function gerarSlug(texto) {
  return (
    String(texto)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'meu-pack'
  );
}

/** Nome de arquivo seguro no Windows. */
export function nomeDeArquivoSeguro(texto) {
  return String(texto).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'pack';
}

async function montarManifesto(plano, opcoes) {
  const { nome, autor = '', memoriaMb = 4096, versaoDoPack = '1.0.0', loaderVersao } = opcoes;
  const { loader, mc } = plano.alvo;

  const instalador = await planoDeInstalacao(loader, mc, loaderVersao);
  const nomeLoader = LOADERS.find((l) => l.id === loader)?.nome ?? loader;

  const automaticos = plano.arquivos.filter((a) => a.distribuicaoLiberada);
  const manuais = plano.arquivos.filter((a) => !a.distribuicaoLiberada);

  return {
    formato: 1,
    nome,
    slug: gerarSlug(nome),
    autor,
    versaoDoPack,
    criadoEm: new Date().toISOString(),
    minecraft: mc,
    loader,
    loaderNome: nomeLoader,
    loaderVersao,
    loaderInstalador: {
      tipo: instalador.tipo,
      url: instalador.instaladorUrl,
      arquivo: instalador.instaladorArquivo,
      argumentos: instalador.argumentos,
      versionId: instalador.versionId,
    },
    memoriaMb,
    carregadorShader: plano.carregadorShader,
    shaderAtivo: plano.arquivos.find((a) => a.tipo === 'shader')?.arquivo?.nome ?? null,
    tamanhoTotal: automaticos.reduce((s, a) => s + (a.arquivo?.tamanho ?? 0), 0),
    mods: automaticos.map((a) => ({
      nome: a.nome,
      pasta: a.tipo === 'shader' ? 'shaderpacks' : a.tipo === 'resourcepack' ? 'resourcepacks' : 'mods',
      arquivo: a.arquivo.nome,
      url: a.arquivo.url,
      sha1: a.arquivo.sha1,
      tamanho: a.arquivo.tamanho,
      fonte: a.fonte,
      origem: a.origem,
      pagina: a.pagina,
    })),
    manuais: manuais.map((a) => ({
      nome: a.nome,
      arquivo: a.arquivo?.nome ?? null,
      pagina: a.paginaDoArquivo ?? a.pagina,
    })),
  };
}

const MARCADOR = '#==PAYLOAD==';

/** Quebra o base64 em linhas para o .bat não virar uma linha única de 200 KB. */
function quebrarEmLinhas(texto, largura = 120) {
  const linhas = [];
  for (let i = 0; i < texto.length; i += largura) linhas.push(texto.slice(i, i + largura));
  return linhas.join('\r\n');
}

export async function gerarBat(plano, opcoes) {
  const manifesto = await montarManifesto(plano, opcoes);

  const molde = await readFile(MOLDE_BAT, 'utf8');
  const manifestoB64 = Buffer.from(JSON.stringify(manifesto), 'utf8').toString('base64');
  const script = molde.replace('@@MANIFESTO@@', manifestoB64);
  const scriptB64 = Buffer.from(script, 'utf8').toString('base64');

  // O .bat abre o PowerShell, manda ele ler o próprio .bat, pegar tudo depois do
  // marcador, decodificar e executar. Dentro das aspas duplas o cmd não mexe em
  // nada, então o único cuidado é não usar aspas duplas na linha de comando.
  const cabecalho = [
    '@echo off',
    'chcp 65001 >nul',
    `title Instalar ${nomeDeArquivoSeguro(manifesto.nome).replace(/[^\x20-\x7e]/g, '')}`,
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "' +
      [
        "$ErrorActionPreference='Stop'",
        "$t=[IO.File]::ReadAllText('%~f0')",
        `$m='${MARCADOR}'`,
        '$i=$t.LastIndexOf($m)',
        "if($i -lt 0){Write-Host 'Arquivo incompleto. Baixe o .bat de novo.' -ForegroundColor Red; pause; exit 1}",
        "$b=($t.Substring($i+$m.Length) -replace '\\s','')",
        '$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))',
        'Invoke-Expression $s',
      ].join('; ') +
      '"',
    'exit /b',
    MARCADOR,
    '',
  ].join('\r\n');

  return {
    nomeArquivo: `Instalar ${nomeDeArquivoSeguro(manifesto.nome)}.bat`,
    conteudo: Buffer.from(cabecalho + quebrarEmLinhas(scriptB64) + '\r\n', 'utf8'),
    manifesto,
  };
}

const CHAVE_DEPENDENCIA = {
  fabric: 'fabric-loader',
  quilt: 'quilt-loader',
  forge: 'forge',
  neoforge: 'neoforge',
};

export async function gerarMrpack(plano, opcoes) {
  const { nome, versaoDoPack = '1.0.0', loaderVersao } = opcoes;
  const { loader, mc } = plano.alvo;

  const indice = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: versaoDoPack,
    name: nome,
    summary: opcoes.resumo ?? `Montado no ModpackForge para Minecraft ${mc}`,
    files: plano.arquivos
      .filter((a) => a.distribuicaoLiberada && a.arquivo?.url)
      .map((a) => {
        const hashes = {};
        if (a.arquivo.sha1) hashes.sha1 = a.arquivo.sha1;
        if (a.arquivo.sha512) hashes.sha512 = a.arquivo.sha512;
        return {
          path: `${a.tipo === 'shader' ? 'shaderpacks' : a.tipo === 'resourcepack' ? 'resourcepacks' : 'mods'}/${a.arquivo.nome}`,
          hashes,
          env: {
            // Sempre "required" no cliente, de propósito.
            //
            // O rótulo client_side da Modrinth descreve servidor dedicado contra
            // cliente, e é pouco confiável para packs: mods de estrutura e de
            // geração de mundo vêm marcados como "unsupported" no cliente, ainda
            // que o modo um jogador precise deles — no singleplayer o cliente roda
            // um servidor interno. O Prism obedece esse campo ao pé da letra e não
            // instala o arquivo, e o jogo quebra pedindo justamente o mod que a
            // loja mandou pular. Já aconteceu aqui com o Structure Pool API, do
            // qual dois mods de cliente dependiam.
            //
            // Tudo que está neste pack entrou porque o cliente precisa.
            client: 'required',
            server: ['shader', 'resourcepack'].includes(a.tipo) || a.ladoServidor === 'unsupported' ? 'unsupported' : 'required',
          },
          downloads: [a.arquivo.url],
          fileSize: a.arquivo.tamanho ?? 0,
        };
      }),
    dependencies: {
      minecraft: mc,
      [CHAVE_DEPENDENCIA[loader]]: loaderVersao,
    },
  };

  const manuais = plano.arquivos.filter((a) => !a.distribuicaoLiberada);
  const entradas = [
    { caminho: 'modrinth.index.json', dados: JSON.stringify(indice, null, 2) },
  ];

  if (manuais.length) {
    entradas.push({
      caminho: 'overrides/LEIA-ME.txt',
      dados:
        'Estes mods precisam de download manual porque o autor desativou a\r\n' +
        'distribuicao automatica na CurseForge. Baixe cada .jar e coloque na\r\n' +
        'pasta mods do pack:\r\n\r\n' +
        manuais.map((m) => `  ${m.nome}\r\n    ${m.paginaDoArquivo ?? m.pagina}`).join('\r\n'),
    });
  }

  const shaderAtivo = plano.arquivos.find((a) => a.tipo === 'shader');
  if (shaderAtivo && plano.carregadorShader?.config) {
    entradas.push({
      caminho: `overrides/config/${plano.carregadorShader.config}`,
      dados: `shaderPack=${shaderAtivo.arquivo.nome}\n`,
    });
  }

  return {
    nomeArquivo: `${nomeDeArquivoSeguro(nome)}.mrpack`,
    conteudo: montarZip(entradas),
    contagem: indice.files.length,
  };
}

/** Lista simples, para quem só quer conferir ou colar num grupo. */
export function gerarListaTexto(plano, opcoes) {
  const { loader, mc } = plano.alvo;
  const nomeLoader = LOADERS.find((l) => l.id === loader)?.nome ?? loader;
  const linhas = [
    opcoes.nome,
    `Minecraft ${mc} - ${nomeLoader} ${opcoes.loaderVersao}`,
    `${plano.arquivos.length} arquivos (mods, shaders e recursos)`,
    '',
  ];
  const escolhidos = plano.arquivos.filter((a) => a.origem === 'escolhido');
  const deps = plano.arquivos.filter((a) => a.origem === 'dependencia');

  linhas.push(`Escolhidos (${escolhidos.length})`);
  for (const a of escolhidos) linhas.push(`  ${a.nome}  ${a.versaoNumero}`);
  if (deps.length) {
    linhas.push('', `Dependencias adicionadas automaticamente (${deps.length})`);
    for (const a of deps) linhas.push(`  ${a.nome}  ${a.versaoNumero}   <- ${a.exigidoPor.join(', ')}`);
  }
  return {
    nomeArquivo: `${nomeDeArquivoSeguro(opcoes.nome)} - lista.txt`,
    conteudo: Buffer.from(linhas.join('\r\n'), 'utf8'),
  };
}
