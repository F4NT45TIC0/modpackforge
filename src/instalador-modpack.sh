#!/usr/bin/env bash
# Instala no Linux o lado servidor de um modpack publicado na Modrinth.
set -euo pipefail

PACK_NOME=@@PACK_NOME@@
PACK_SLUG=@@PACK_SLUG@@
MC_VERSAO=@@MC_VERSAO@@
LOADER_NOME=@@LOADER_NOME@@
LOADER_VERSAO=@@LOADER_VERSAO@@
LOADER_URL=@@LOADER_URL@@
LOADER_JAR=@@LOADER_JAR@@
LOADER_LANCADOR=@@LOADER_LANCADOR@@
PACK_URL=@@PACK_URL@@
PACK_SHA1=@@PACK_SHA1@@
MEMORIA_MB=@@MEMORIA_MB@@
PORTA=@@PORTA@@
LOADER_ARGS=(@@LOADER_ARGS@@)
ARQUIVOS=(
@@ARQUIVOS@@
)
OVERRIDES=(
@@OVERRIDES@@
)
EXCLUIDOS=(
@@EXCLUIDOS@@
)

baixar() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
  else
    wget -q --tries=3 -O "$2" "$1"
  fi
}

echo ""
echo "  $PACK_NOME — servidor Minecraft $MC_VERSAO / $LOADER_NOME $LOADER_VERSAO"
for comando in java unzip sha1sum; do
  if ! command -v "$comando" >/dev/null 2>&1; then
    echo "  Preciso de $comando. Instale e rode novamente." >&2
    exit 1
  fi
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "  Preciso de curl ou wget." >&2
  exit 1
fi

PADRAO="$HOME/servidores/$PACK_SLUG"
printf '  Pasta do servidor [Enter = %s]: ' "$PADRAO"
DESTINO=""
if [ -r /dev/tty ]; then read -r DESTINO </dev/tty || true; else read -r DESTINO || true; fi
DESTINO="${DESTINO:-$PADRAO}"
mkdir -p "$DESTINO"
DESTINO="$(cd "$DESTINO" && pwd)"

TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
ARQUIVO_PACK="$TEMP/pack.mrpack"
echo "  Baixando o .mrpack..."
baixar "$PACK_URL" "$ARQUIVO_PACK"
if [ -n "$PACK_SHA1" ] && [ "$(sha1sum "$ARQUIVO_PACK" | cut -d' ' -f1)" != "$PACK_SHA1" ]; then
  echo "  O hash do .mrpack não confere." >&2
  exit 1
fi

if [ ! -f "$DESTINO/run.sh" ] && { [ -z "$LOADER_LANCADOR" ] || [ ! -f "$DESTINO/$LOADER_LANCADOR" ]; }; then
  echo "  Instalando $LOADER_NOME $LOADER_VERSAO..."
  baixar "$LOADER_URL" "$TEMP/$LOADER_JAR"
  ARGS=()
  for argumento in "${LOADER_ARGS[@]}"; do ARGS+=("${argumento//\{DIR\}/$DESTINO}"); done
  (cd "$DESTINO" && java -jar "$TEMP/$LOADER_JAR" "${ARGS[@]}")
fi

echo "  Baixando ${#ARQUIVOS[@]} arquivos do servidor..."
falhas=0
for item in "${ARQUIVOS[@]}"; do
  IFS='|' read -r caminho hash url <<< "$item"
  destino="$DESTINO/$caminho"
  mkdir -p "$(dirname "$destino")"
  if [ -f "$destino" ] && [ "$(sha1sum "$destino" | cut -d' ' -f1)" = "$hash" ]; then
    echo "  Já estava aqui: $caminho"
    continue
  fi
  if ! baixar "$url" "$destino.parcial"; then
    echo "  Falhou: $caminho" >&2
    rm -f "$destino.parcial"
    falhas=$((falhas + 1))
    continue
  fi
  if [ "$(sha1sum "$destino.parcial" | cut -d' ' -f1)" != "$hash" ]; then
    echo "  Hash incorreto: $caminho" >&2
    rm -f "$destino.parcial"
    falhas=$((falhas + 1))
    continue
  fi
  mv -f "$destino.parcial" "$destino"
  echo "  OK: $caminho"
done

# A especificação aplica os overrides comuns primeiro e os do servidor depois.
# unzip -p extrai somente o arquivo indicado; os caminhos foram validados ao gerar este script.
for item in "${OVERRIDES[@]}"; do
  IFS='|' read -r origem caminho <<< "$item"
  destino="$DESTINO/$caminho"
  mkdir -p "$(dirname "$destino")"
  if ! unzip -p "$ARQUIVO_PACK" "$origem" > "$destino.parcial"; then
    echo "  Não consegui extrair $origem" >&2
    rm -f "$destino.parcial"
    falhas=$((falhas + 1))
    continue
  fi
  mv -f "$destino.parcial" "$destino"
done

if [ ! -f "$DESTINO/server.properties" ]; then
  printf 'server-port=%s\nmotd=%s\nonline-mode=true\n' "$PORTA" "$PACK_NOME" > "$DESTINO/server.properties"
fi

if ! grep -qi '^eula=true' "$DESTINO/eula.txt" 2>/dev/null; then
  echo "  Para iniciar, leia https://aka.ms/MinecraftEULA"
  printf '  Digite aceito para concordar: '
  RESPOSTA=""
  if [ -r /dev/tty ]; then read -r RESPOSTA </dev/tty || true; else read -r RESPOSTA || true; fi
  if [ "${RESPOSTA,,}" = 'aceito' ]; then printf 'eula=true\n' > "$DESTINO/eula.txt"; fi
fi

cat > "$DESTINO/iniciar.sh" <<INICIAR
#!/usr/bin/env bash
cd "\$(dirname "\$0")" || exit 1
if [ -f run.sh ]; then
  printf -- '-Xmx%sM -Xms1024M\n' "$MEMORIA_MB" > user_jvm_args.txt
  exec ./run.sh nogui
fi
for jar in "$LOADER_LANCADOR" quilt-server-launch.jar fabric-server-launch.jar server.jar minecraft_server.jar; do
  if [ -n "\$jar" ] && [ -f "\$jar" ]; then exec java -Xmx${MEMORIA_MB}M -Xms1024M -jar "\$jar" nogui; fi
done
echo 'Não achei o jar do servidor.' >&2
exit 1
INICIAR
chmod +x "$DESTINO/iniciar.sh"
[ ! -f "$DESTINO/run.sh" ] || chmod +x "$DESTINO/run.sh"

echo ""
echo "  ${#EXCLUIDOS[@]} arquivos exclusivos do cliente ficaram de fora."
echo "  Pasta: $DESTINO"
echo "  Para iniciar: cd \"$DESTINO\" && ./iniciar.sh"
echo "  Libere a porta TCP $PORTA no firewall da VPS se necessário."
if [ "$falhas" -gt 0 ]; then
  echo "  $falhas arquivos falharam. Rode o instalador novamente." >&2
  exit 1
fi
