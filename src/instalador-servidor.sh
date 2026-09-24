#!/usr/bin/env bash
# Instalador de servidor gerado pelo ModpackForge.
# Jogue este arquivo na VPS, rode, e o servidor fica pronto para subir.
#
# Nao instala nada no sistema fora da pasta escolhida, e nao mexe em firewall:
# quando precisar liberar porta, ele mostra o comando para voce decidir.

set -uo pipefail

PACK_NOME="@@PACK_NOME@@"
PACK_SLUG="@@PACK_SLUG@@"
PACK_AUTOR="@@PACK_AUTOR@@"
MC_VERSAO="@@MC_VERSAO@@"
LOADER_NOME="@@LOADER_NOME@@"
LOADER_VERSAO="@@LOADER_VERSAO@@"
LOADER_URL="@@LOADER_URL@@"
LOADER_JAR="@@LOADER_JAR@@"
LOADER_LANCADOR="@@LOADER_LANCADOR@@"
MEMORIA_MB="@@MEMORIA_MB@@"
PORTA="@@PORTA@@"
TOTAL_MODS="@@TOTAL_MODS@@"

LOADER_ARGS=(@@LOADER_ARGS@@)

# Cada linha: nome|arquivo|sha1|url
MODS=(
@@MODS@@
)

SOMENTE_CLIENTE=(
@@SOMENTE_CLIENTE@@
)

# ------------------------------------------------------------------ enfeite

if [ -t 1 ]; then
  N=$'\e[0m'; B=$'\e[1m'; VERM=$'\e[31m'; VERD=$'\e[32m'; AMAR=$'\e[33m'; CIA=$'\e[36m'; CINZ=$'\e[90m'
else
  N=""; B=""; VERM=""; VERD=""; AMAR=""; CIA=""; CINZ=""
fi
titulo() { printf '\n%s%s%s\n%s%s%s\n' "$B" "  $1" "$N" "$CINZ" "  $(printf '%*s' "${#1}" '' | tr ' ' '-')" "$N"; }
ok()     { printf '%s  %s%s\n' "$VERD" "$1" "$N"; }
aviso()  { printf '%s  %s%s\n' "$AMAR" "$1" "$N"; }
erro()   { printf '%s  %s%s\n' "$VERM" "$1" "$N"; }
nota()   { printf '%s  %s%s\n' "$CINZ" "$1" "$N"; }

# De onde ler as respostas.
#
# Quando o script chega por um pipe ("curl ... | bash"), a entrada padrao e o
# proprio script e as perguntas precisam vir do terminal. Quando nao ha terminal
# (execucao automatizada), as respostas vem da entrada padrao mesmo.
#
# O teste tem que ser feito dentro de um subshell: se a abertura de /dev/tty
# falha, o bash imprime o erro antes de qualquer redirecionamento na mesma linha
# ter efeito, e a mensagem vaza para a tela.
if ( : </dev/tty ) 2>/dev/null; then TEM_TERMINAL=1; else TEM_TERMINAL=0; fi

RESPOSTA=""
perguntar() {
  printf '%s' "$1"
  RESPOSTA=""
  if [ "$TEM_TERMINAL" = "1" ] && [ ! -t 0 ]; then
    read -r RESPOSTA </dev/tty || RESPOSTA=""
  else
    read -r RESPOSTA || RESPOSTA=""
  fi
}

printf '\n%s  %s%s\n' "$CIA$B" "$PACK_NOME" "$N"
printf '%s  Servidor Minecraft %s - %s %s%s\n' "$CIA" "$MC_VERSAO" "$LOADER_NOME" "$LOADER_VERSAO" "$N"
nota "$TOTAL_MODS mods de servidor"
[ -n "$PACK_AUTOR" ] && nota "Montado por $PACK_AUTOR"

# ------------------------------------------------------------- ferramentas

BAIXAR=""
if command -v curl >/dev/null 2>&1; then BAIXAR="curl"
elif command -v wget >/dev/null 2>&1; then BAIXAR="wget"
else
  erro "Preciso de curl ou wget e nao achei nenhum dos dois."
  nota "Ubuntu/Debian: sudo apt install -y curl"
  nota "Oracle Linux/RHEL: sudo dnf install -y curl"
  exit 1
fi

baixar_para() { # url destino
  if [ "$BAIXAR" = "curl" ]; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
  else
    wget -q --tries=3 -O "$2" "$1"
  fi
}

SHA1=""
if command -v sha1sum >/dev/null 2>&1; then SHA1="sha1sum"
elif command -v shasum >/dev/null 2>&1; then SHA1="shasum"
fi
calcular_sha1() { [ -n "$SHA1" ] && $SHA1 "$1" | cut -d' ' -f1 || echo ""; }

titulo "Java"
if ! command -v java >/dev/null 2>&1; then
  erro "Java nao encontrado."
  nota "Ubuntu/Debian: sudo apt update && sudo apt install -y openjdk-21-jre-headless"
  nota "Oracle Linux/RHEL: sudo dnf install -y java-21-openjdk-headless"
  nota "Depois rode este arquivo de novo."
  exit 1
fi
JAVA_VERSAO=$(java -version 2>&1 | head -1)
ok "$JAVA_VERSAO"

# ------------------------------------------------------------------ destino

PADRAO="$HOME/servidores/$PACK_SLUG"
titulo "Onde instalar"
nota "Padrao: $PADRAO"
perguntar "  Enter para aceitar, ou digite outro caminho: "
DESTINO="${RESPOSTA:-$PADRAO}"
mkdir -p "$DESTINO/mods"
DESTINO="$(cd "$DESTINO" && pwd)"
ok "$DESTINO"

# --------------------------------------------------------------- modloader

titulo "Modloader"
# Marcadores concretos de que o loader ja foi instalado aqui. Testar a pasta
# "libraries" nao serve: ela existe assim que o instalador comeca.
JA_INSTALADO=0
if [ -n "$LOADER_LANCADOR" ] && [ -f "$DESTINO/$LOADER_LANCADOR" ]; then JA_INSTALADO=1; fi
if [ -f "$DESTINO/run.sh" ]; then JA_INSTALADO=1; fi

if [ "$JA_INSTALADO" = "1" ]; then
  ok "$LOADER_NOME ja esta instalado aqui."
else
  nota "Baixando o instalador do $LOADER_NOME..."
  TEMP_JAR="$DESTINO/.$LOADER_JAR"
  if ! baixar_para "$LOADER_URL" "$TEMP_JAR"; then
    erro "Nao consegui baixar o instalador do $LOADER_NOME."
    exit 1
  fi
  nota "Instalando (isso baixa o Minecraft e pode demorar)..."
  ARGS=()
  for a in "${LOADER_ARGS[@]}"; do ARGS+=("${a//\{DIR\}/$DESTINO}"); done
  if ( cd "$DESTINO" && java -jar "$TEMP_JAR" "${ARGS[@]}" ); then
    ok "$LOADER_NOME $LOADER_VERSAO instalado."
  else
    erro "O instalador do $LOADER_NOME falhou."
    rm -f "$TEMP_JAR"
    exit 1
  fi
  rm -f "$TEMP_JAR" "$DESTINO"/*installer*.log 2>/dev/null
fi

# -------------------------------------------------------------------- mods

titulo "Mods ($TOTAL_MODS)"
REGISTRO="$DESTINO/.modpackforge-servidor"
ESPERADOS="$DESTINO/.modpackforge-esperados"
: > "$ESPERADOS"

baixados=0; reaproveitados=0; falhou=0; indice=0
PARALELO=6

baixar_mod() { # nome arquivo sha1 url posicao
  local nome="$1" arquivo="$2" sha="$3" url="$4" pos="$5"
  local destino="$DESTINO/mods/$arquivo"
  if [ -f "$destino" ] && [ -n "$sha" ] && [ "$(calcular_sha1 "$destino")" = "$sha" ]; then
    printf '  [%3d/%d] %s%s ja estava aqui%s\n' "$pos" "$TOTAL_MODS" "$nome" "$CINZ" "$N"
    return 2
  fi
  if ! baixar_para "$url" "$destino.parcial"; then
    printf '  [%3d/%d] %s%s falhou (download)%s\n' "$pos" "$TOTAL_MODS" "$nome" "$VERM" "$N"
    rm -f "$destino.parcial"; return 1
  fi
  if [ -n "$sha" ]; then
    local obtido; obtido="$(calcular_sha1 "$destino.parcial")"
    if [ -n "$obtido" ] && [ "$obtido" != "$sha" ]; then
      printf '  [%3d/%d] %s%s falhou (arquivo corrompido)%s\n' "$pos" "$TOTAL_MODS" "$nome" "$VERM" "$N"
      rm -f "$destino.parcial"; return 1
    fi
  fi
  mv -f "$destino.parcial" "$destino"
  printf '  [%3d/%d] %s%s ok%s\n' "$pos" "$TOTAL_MODS" "$nome" "$VERD" "$N"
  return 0
}

RESULTADOS="$(mktemp)"
for linha in "${MODS[@]}"; do
  IFS='|' read -r m_nome m_arquivo m_sha m_url <<< "$linha"
  [ -z "$m_arquivo" ] && continue
  indice=$((indice + 1))
  printf '%s\n' "$m_arquivo" >> "$ESPERADOS"
  {
    baixar_mod "$m_nome" "$m_arquivo" "$m_sha" "$m_url" "$indice"
    printf '%s\n' "$?" >> "$RESULTADOS"
  } &
  while [ "$(jobs -rp | wc -l)" -ge "$PARALELO" ]; do wait -n 2>/dev/null || break; done
done
wait

while read -r codigo; do
  case "$codigo" in
    0) baixados=$((baixados + 1)) ;;
    2) reaproveitados=$((reaproveitados + 1)) ;;
    *) falhou=$((falhou + 1)) ;;
  esac
done < "$RESULTADOS"
rm -f "$RESULTADOS"

# Tira o que este instalador colocou antes e o pack nao usa mais.
removidos=0
if [ -f "$REGISTRO" ]; then
  while read -r antigo; do
    [ -z "$antigo" ] && continue
    if ! grep -qxF "$antigo" "$ESPERADOS" && [ -f "$DESTINO/mods/$antigo" ]; then
      rm -f "$DESTINO/mods/$antigo"; removidos=$((removidos + 1))
    fi
  done < "$REGISTRO"
fi
mv -f "$ESPERADOS" "$REGISTRO"

# ---------------------------------------------------------------- acordo

titulo "Acordo de licenca da Mojang"
if grep -qi '^eula=true' "$DESTINO/eula.txt" 2>/dev/null; then
  ok "Ja aceito neste servidor."
else
  nota "Para rodar um servidor voce precisa aceitar o EULA da Minecraft:"
  nota "https://aka.ms/MinecraftEULA"
  perguntar "  Digite ${B}aceito${N} para concordar (qualquer outra coisa cancela): "
  if [ "$(printf '%s' "$RESPOSTA" | tr '[:upper:]' '[:lower:]')" = "aceito" ]; then
    printf 'eula=true\n' > "$DESTINO/eula.txt"
    ok "EULA aceito e gravado em eula.txt."
  else
    aviso "EULA nao aceito. O servidor nao vai subir ate voce colocar eula=true em:"
    nota "$DESTINO/eula.txt"
  fi
fi

# --------------------------------------------------------- configuracoes

if [ ! -f "$DESTINO/server.properties" ]; then
  cat > "$DESTINO/server.properties" <<PROPS
server-port=$PORTA
motd=$PACK_NOME
max-players=10
online-mode=true
view-distance=8
simulation-distance=6
enable-command-block=false
PROPS
  ok "server.properties criado (porta $PORTA)."
else
  nota "server.properties ja existia; nao mexi nele."
fi

# ----------------------------------------------------------- como iniciar

cat > "$DESTINO/iniciar.sh" <<INICIAR
#!/usr/bin/env bash
# Sobe o servidor. Gerado pelo ModpackForge.
cd "\$(dirname "\$0")" || exit 1
MEM=$MEMORIA_MB

if [ -f run.sh ]; then
  # Forge e NeoForge geram o proprio script de inicializacao.
  printf -- '-Xmx%sM -Xms1024M\n' "\$MEM" > user_jvm_args.txt
  exec ./run.sh nogui
fi

for jar in $LOADER_LANCADOR quilt-server-launch.jar fabric-server-launch.jar server.jar minecraft_server.jar; do
  if [ -n "\$jar" ] && [ -f "\$jar" ]; then
    exec java -Xmx\${MEM}M -Xms1024M -XX:+UseG1GC -jar "\$jar" nogui
  fi
done

echo "Nao achei o jar do servidor nesta pasta." >&2
exit 1
INICIAR
chmod +x "$DESTINO/iniciar.sh"
[ -f "$DESTINO/run.sh" ] && chmod +x "$DESTINO/run.sh" 2>/dev/null

# -------------------------------------------------------------- fechamento

titulo "Pronto"
ok "$baixados baixados, $reaproveitados ja estavam na pasta, $removidos removidos."
[ "$falhou" -gt 0 ] && aviso "$falhou falharam. Rode de novo: ele so tenta os que faltaram."
nota "Pasta do servidor: $DESTINO"

if [ "${#SOMENTE_CLIENTE[@]}" -gt 0 ] && [ -n "${SOMENTE_CLIENTE[0]:-}" ]; then
  printf '\n'
  aviso "${#SOMENTE_CLIENTE[@]} mods do seu pack sao so de cliente e ficaram de fora:"
  for m in "${SOMENTE_CLIENTE[@]}"; do [ -n "$m" ] && nota "  $m"; done
  nota "Eles derrubariam o servidor. Quem entra no jogo continua usando eles normalmente."
fi

titulo "Para subir o servidor"
printf '  %scd %s && ./iniciar.sh%s\n' "$B" "$DESTINO" "$N"
printf '\n'
nota "Para ele continuar rodando depois que voce sair do SSH:"
printf '  %sscreen -S minecraft ./iniciar.sh%s   (sair sem parar: Ctrl+A, depois D)\n' "$B" "$N"
printf '\n'
aviso "Na Oracle Cloud a porta $PORTA precisa ser liberada em dois lugares:"
nota "1. No painel da Oracle: Networking > VCN > Security Lists > adicionar regra"
nota "   de entrada TCP para a porta $PORTA, origem 0.0.0.0/0."
nota "2. No firewall da maquina. Confira qual voce usa e rode um destes:"
printf '     %ssudo firewall-cmd --permanent --add-port=%s/tcp && sudo firewall-cmd --reload%s\n' "$CINZ" "$PORTA" "$N"
printf '     %ssudo iptables -I INPUT 6 -p tcp --dport %s -j ACCEPT && sudo netfilter-persistent save%s\n' "$CINZ" "$PORTA" "$N"
nota "Nao mexo no seu firewall sozinho: isso e configuracao de seguranca da maquina."
printf '\n'
