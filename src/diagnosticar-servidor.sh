#!/usr/bin/env bash
# Le um log sem executar seu conteudo nem modificar mods ou configuracoes.
set -euo pipefail
LOG="${1:-logs/latest.log}"
MODO="${2:-}"
if [ ! -f "$LOG" ] || [ ! -r "$LOG" ]; then
  echo "Nao consegui ler o log: $LOG" >&2; exit 2
fi
TEMP_DIAGNOSTICO="$(mktemp)"
trap 'rm -f -- "$TEMP_DIAGNOSTICO"' EXIT
# Evita sequencias de controle do terminal vindas do log; limita linhas gigantes.
LC_ALL=C tr -cd '\11\12\15\40-\176' < "$LOG" | cut -c1-1200 > "$TEMP_DIAGNOSTICO"
achou=0
caso() {
  local padrao="$1" titulo="$2" orientacao="$3"
  if grep -Eqi -- "$padrao" "$TEMP_DIAGNOSTICO"; then
    achou=1
    printf '\nCausa provavel: %s\nO que fazer: %s\nTrecho do log:\n' "$titulo" "$orientacao"
    grep -Ei -A 4 -- "$padrao" "$TEMP_DIAGNOSTICO" | sed -n '1,14p'
  fi
}
printf 'Diagnostico do servidor\nLog analisado: %s\n' "$LOG"
echo 'As orientacoes abaixo dependem do erro registrado; nenhum arquivo foi alterado.'

caso 'UnsupportedClassVersionError|class file version|Unsupported Java|requires.*[Jj]ava|[Jj]ava.*required' \
  'Java incompativel' \
  'Confira as versoes permitidas em verificacao-pack.txt e selecione essa versao de Java na VPS. Nao remova mods para corrigir apenas a versao do Java.'
caso 'DuplicateModsFoundException|Duplicate mods|duplicate mod id|Found duplicate.*(mod|[.]jar)|Duplicate.*mod.*ID' \
  'Duas copias do mesmo mod' \
  'Confira os arquivos citados abaixo e mantenha uma unica versao compativel em mods/. Tire a outra copia do pack e gere novamente; nao retire uma biblioteca diferente so por ter nome parecido.'
caso 'Incompatible mods found|ModResolutionException|Missing.*dependenc|requires.*(missing|absent)|which is missing|requires.*version|needs.*version|mandatory dependenc|Missing or unsupported mandatory dependencies|depends on|(^|[[:space:]-])(Add|Replace|Install) mod ' \
  'Dependencia ausente ou versao/ambiente incompativel' \
  'Siga as linhas requires/depends e as sugestoes Add/Replace/Install do log: adicione a biblioteca que falta ou troque a versao indicada. Confira Minecraft, loader e Java. Remover a biblioteca pode criar outros erros.'
caso 'Attempted to load class.*(invalid dist|DEDICATED_SERVER)|Cannot load class.*environment type SERVER|NoClassDefFoundError.*net/minecraft/client|ClassNotFoundException.*net[./]minecraft[./]client' \
  'Codigo exclusivo do cliente no servidor' \
  'Localize no erro o mod ou JAR que tentou carregar classes de cliente e retire esse mod somente do serverpack. A classe net.minecraft.client sozinha nao identifica o mod responsavel; nao remova outros mods por tentativa.'
caso 'ParsingException|JsonSyntaxException|JsonParseException|MalformedJsonException|TomlParsingException|Failed to (load|read|parse).*config|[Ii]nvalid.*config|[Cc]onfig.*(invalid|corrupt)' \
  'Configuracao ou dados que nao podem ser lidos' \
  'Confira o caminho e a linha do arquivo no erro (pode ser config, receita ou datapack). Com o servidor parado, faca backup desse arquivo e corrija a sintaxe ou restaure o original da mesma versao do pack. Regenerar a config pode perder receitas e ajustes do autor; nao apague toda a pasta config.'
caso 'OutOfMemoryError|Could not reserve enough space|Cannot allocate memory|unable to create native thread' \
  'Memoria insuficiente' \
  'Confira a RAM livre e a memoria configurada no instalador/iniciar.sh. Deixe memoria para o sistema; se a VPS for pequena, reduza o pack ou aumente a RAM. Este erro sozinho nao indica qual mod retirar.'
caso 'Address already in use|FAILED TO BIND TO PORT|BindException' \
  'Porta ocupada' \
  'Pare a outra instancia do servidor ou escolha uma porta livre em server.properties. Rode verificar-servidor.sh com o servidor principal parado.'
caso 'No space left on device|Permission denied|AccessDeniedException' \
  'Disco cheio ou permissao insuficiente' \
  'Confira espaco livre e permissao de escrita da pasta do servidor. Execute com o usuario dono da pasta; trocar mods nao resolve esse erro.'
caso 'MixinApplyError|MixinTransformerError|InvalidMixinException|Mixin.*failed|InjectionError|Critical injection failure' \
  'Falha de mixin: possivel incompatibilidade de codigo' \
  'Confira o arquivo .mixins.json e os mods citados no erro. Use versoes compativeis com Minecraft/loader e com os outros mods. O nome do mixin e uma pista, nao prova qual mod retirar; preserve o log completo para investigar.'
caso 'Unable to access jarfile|Nao achei o jar|Could not find or load main class|Invalid or corrupt jarfile' \
  'Inicializador ou JAR ausente/corrompido' \
  'Rode novamente o instalador gerado, na mesma pasta, e confira se o loader terminou de instalar. Nao coloque o JAR do cliente como inicializador do servidor.'

if [ "$MODO" = timeout ]; then
  printf '\nO teste esgotou o tempo sem confirmar a inicializacao.\n'
  echo 'Se o log continua avancando, tente MPF_TEMPO_TESTE=600 bash verificar-servidor.sh. Tempo esgotado sozinho nao confirma incompatibilidade.'
elif [ "$MODO" = 137 ]; then
  printf '\nO processo terminou com codigo 137 (SIGKILL).\n'
  echo 'Pode ser o limite de RAM da VPS/container ou encerramento externo. Confira o painel e os registros do sistema; o codigo sozinho nao prova falta de memoria.'
fi
if [ "$achou" = 0 ]; then
  printf '\nNao identifiquei uma causa especifica pelas regras do diagnostico.\n'
  echo 'Nao ha evidencia suficiente para indicar um mod a remover. Confira o primeiro erro e Caused by no log completo e o crash-report correspondente.'
  tail -n 20 "$TEMP_DIAGNOSTICO"
fi
printf '\nSe alterar mods, confira novamente as dependencias e repita o teste.\n'
