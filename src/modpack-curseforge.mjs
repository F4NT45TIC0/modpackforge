import { readFile } from 'node:fs/promises';
import * as curseforge from './curseforge.mjs';
import { lerDiretorioZipRemoto, lerArquivoZipRemoto } from './ler-zip-remoto.mjs';
import { planoDeInstalacaoServidor } from './loaders.mjs';
import { gerarSlug } from './exportar.mjs';
import { auditarPack } from './auditoria.mjs';
import { criarVerificador, criarDiagnostico, textoVerificacao } from './verificador-servidor.mjs';
import { criarExtratorPack } from './extrator-pack.mjs';

const aspas = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function conferirArquivoCurseforge(arquivo) {
  const u = new URL(arquivo?.url);
  if (u.protocol !== 'https:' || u.username || u.password ||
      !['edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net'].includes(u.hostname) ||
      !/^[a-f0-9]{40}$/i.test(arquivo.sha1 ?? '')) {
    throw new Error('Download oficial indisponível ou sem SHA-1. Abra a página do arquivo na CurseForge.');
  }
}

export function alvoDoManifesto(manifesto) {
  const mc = String(manifesto.minecraft?.version ?? '');
  const loaders = manifesto.minecraft?.modLoaders ?? [];
  const primarios = loaders.filter((l) => l.primary);
  const escolhido = primarios.length === 1 ? primarios[0] : loaders.length === 1 ? loaders[0] : null;
  const partes = /^(forge|neoforge|fabric|quilt)-([\w.+-]{1,64})$/.exec(escolhido?.id ?? '');
  if (manifesto.manifestType !== 'minecraftModpack' || !/^[\w.+-]{1,32}$/.test(mc) || !partes) {
    throw new Error('O manifesto do modpack não declara Minecraft e um loader suportado.');
  }
  // Alguns manifests incluem a versão de Minecraft no ID do Forge.
  const loaderVersao = partes[1] === 'forge' && partes[2].startsWith(mc + '-') ? partes[2].slice(mc.length + 1) : partes[2];
  return { mc, loader: partes[1], loaderVersao };
}

export function arquivosDoServerpack(entradas) {
  const nomes = [...entradas.keys()].filter((p) => !p.endsWith('/'));
  // ZIPs oficiais podem colocar o servidor dentro de uma pasta de topo.
  const pasta = nomes[0]?.split('/')[0];
  const raiz = pasta && !['mods', 'config', 'defaultconfigs', 'libraries', 'kubejs', 'scripts', 'world'].includes(pasta) &&
    nomes.every((p) => p.startsWith(pasta + '/')) ? pasta + '/' : '';
  const destinos = new Set(), arquivos = [];
  let total = 0;
  for (const origem of nomes) {
    const e = entradas.get(origem), destino = origem.slice(raiz.length);
    if (origem.split('/').some((p) => !p || p === '.' || p === '..') ||
        !destino || destino.length > 240 || /[\\|\x00-\x1f:]/.test(destino) || destino.startsWith('/') ||
        destino.split('/').some((p) => !p || p === '.' || p === '..') ||
        ![0, 8].includes(e.metodo) || (e.flags & 1) || e.tipoUnix === 0xa000) {
      throw new Error(`Caminho ou entrada inválida no serverpack: ${origem}`);
    }
    const identidade = destino.toLowerCase();
    if (destinos.has(identidade)) throw new Error(`Arquivo duplicado no serverpack: ${destino}`);
    destinos.add(identidade);
    total += e.descomprimido;
    if (e.descomprimido > 1024 ** 3 || total > 2 * 1024 ** 3) throw new Error('Serverpack descompactado grande demais.');
    // O loader instalado pelo app gera o início adequado para esta versão.
    // Guarde os scripts originais, mas o EULA precisa do aceite do usuário.
    if (identidade === 'eula.txt') continue;
    const reservado = ['run.sh', 'iniciar.sh', 'verificar-servidor.sh', 'diagnosticar-servidor.sh',
      'user_jvm_args.txt', 'verificacao-pack.txt'].includes(identidade) || identidade.startsWith('.modpackforge');
    arquivos.push({ origem, destino: reservado ? `.modpackforge-oficial/${destino}` : destino });
  }
  if (!arquivos.length) throw new Error('Serverpack vazio.');
  return arquivos;
}

/** Usa o ZIP de servidor vinculado à versão, sem reconstruir a partir do cliente. */
export async function prepararModpackCurseforge(projetoId, versaoId, { memoriaMb = 4096, porta = 25565 } = {}, deps = {}) {
  const provider = deps.provider ?? curseforge;
  const diretorio = deps.diretorio ?? lerDiretorioZipRemoto;
  const lerArquivo = deps.lerArquivo ?? lerArquivoZipRemoto;
  const instalarLoader = deps.instalarLoader ?? planoDeInstalacaoServidor;
  const [projeto, versao] = await Promise.all([provider.projeto(projetoId), provider.versaoPorId(projetoId, versaoId)]);
  if (projeto.tipo !== 'modpack' || versao.projetoId !== projeto.id || versao.ehServerpack) {
    throw new Error('Escolha uma versão de cliente que pertença a este modpack.');
  }
  const cliente = { nome: versao.arquivo.nome, url: versao.arquivo.url, pagina: `${projeto.pagina}/files/${versao.id}` };
  const resumo = { nome: projeto.nome, mc: versao.versoesJogo[0] ?? null, loader: versao.loaders[0] ?? null,
    loaderVersao: null, arquivos: 0, excluidos: 0, oficial: false, avisos: [] };
  const resultado = { cliente, servidor: null, serverpack: null, resumo };
  if (!versao.serverPackId) {
    resumo.avisos.push('Esta versão não tem serverpack oficial vinculado. O ZIP de cliente pode ser importado no launcher; não o use diretamente no servidor.');
    return resultado;
  }
  const oficial = await provider.versaoPorId(projetoId, versao.serverPackId);
  if (oficial.projetoId !== projeto.id || !oficial.ehServerpack ||
      (oficial.versaoClienteId && oficial.versaoClienteId !== versao.id)) {
    throw new Error('O serverpack não corresponde à versão escolhida.');
  }
  resultado.serverpack = { nome: oficial.arquivo.nome, url: oficial.arquivo.url, pagina: `${projeto.pagina}/files/${oficial.id}` };
  resumo.oficial = true;
  if (!versao.arquivo.url || !oficial.arquivo.url) {
    resumo.avisos.push('O autor não liberou o download automático. Baixe os arquivos nas páginas da CurseForge.');
    return resultado;
  }
  conferirArquivoCurseforge(versao.arquivo); conferirArquivoCurseforge(oficial.arquivo);
  const [entradasCliente, entradasServidor] = await Promise.all([diretorio(versao.arquivo.url), diretorio(oficial.arquivo.url)]);
  const manifesto = JSON.parse((await lerArquivo(versao.arquivo.url, entradasCliente.get('manifest.json'))).toString('utf8'));
  const alvo = alvoDoManifesto(manifesto);
  Object.assign(resumo, alvo);
  const arquivos = arquivosDoServerpack(entradasServidor);
  resumo.arquivos = arquivos.length;
  const instalador = await instalarLoader(alvo.loader, alvo.mc, alvo.loaderVersao);
  const verificacao = auditarPack([], { ...alvo, lado: 'server' });
  verificacao.status = 'incompleta';
  verificacao.total = arquivos.filter((a) => /^mods\/.+\.jar$/i.test(a.destino)).length;
  verificacao.avisos.push({ texto: 'Serverpack oficial: vínculo, manifesto e caminhos conferidos. Os JARs internos não foram auditados; execute verificar-servidor.sh após instalar.' });
  // Forge antigo utiliza Java 8; o mínimo do Minecraft não é um máximo.
  if (alvo.loader === 'forge' && Number(alvo.mc.split('.')[1]) <= 16) verificacao.javaPermitidos = [8];
  resumo.verificacao = verificacao;
  const valores = {
    PACK_NOME: aspas(projeto.nome.replace(/[\x00-\x1f]/g, ' ').slice(0, 80)), PACK_SLUG: aspas(gerarSlug(projeto.nome)),
    MC_VERSAO: aspas(alvo.mc), LOADER_NOME: aspas(alvo.loader), LOADER_VERSAO: aspas(alvo.loaderVersao),
    LOADER_URL: aspas(instalador.instaladorUrl), LOADER_JAR: aspas(instalador.instaladorArquivo),
    LOADER_LANCADOR: aspas(instalador.lancador ?? ''), LOADER_ARGS: instalador.argumentos.map(aspas).join(' '),
    PACK_URL: aspas(oficial.arquivo.url), PACK_SHA1: aspas(oficial.arquivo.sha1),
    MEMORIA_MB: String(Math.trunc(Math.max(2048, Math.min(16384, Number(memoriaMb) || 4096)))),
    PORTA: String(Math.trunc(Math.max(1, Math.min(65535, Number(porta) || 25565)))),
    ARQUIVOS: '', EXCLUIDOS: '', OVERRIDES: arquivos.map((a) => `  ${aspas(`${a.origem}|${a.destino}`)}`).join('\n'),
    JAVA_MINIMO: String(verificacao.javaMinimo), JAVA_PERMITIDOS: verificacao.javaPermitidos.join(' '),
    VERIFICACAO: textoVerificacao(verificacao), VERIFICADOR: criarVerificador(), DIAGNOSTICO: criarDiagnostico(),
    EXTRATOR: criarExtratorPack(),
  };
  let script = await readFile(new URL('./instalador-modpack.sh', import.meta.url), 'utf8');
  for (const [chave, valor] of Object.entries(valores)) script = script.split(`@@${chave}@@`).join(valor);
  resultado.servidor = { nome: `instalar-servidor-${gerarSlug(projeto.nome)}.sh`, script: Buffer.from(script.replace(/\r\n/g, '\n')) };
  return resultado;
}
