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
JAVA_MINIMO=@@JAVA_MINIMO@@
JAVA_PERMITIDOS="@@JAVA_PERMITIDOS@@"
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
JAVA_NUMERO=$(java -version 2>&1 | awk -F '"' '/version/{print $2;exit}' | cut -d. -f1)
if [ "$JAVA_NUMERO" = 1 ]; then JAVA_NUMERO=$(java -version 2>&1 | awk -F '"' '/version/{print $2;exit}' | cut -d. -f2); fi
if ! [[ "$JAVA_NUMERO" =~ ^[0-9]+$ ]] || ! [[ " $JAVA_PERMITIDOS " == *" $JAVA_NUMERO "* ]]; then
  echo "  Java incompativel: $JAVA_NUMERO. Versoes permitidas: $JAVA_PERMITIDOS" >&2; exit 1
fi
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "  Preciso de curl ou wget." >&2
  exit 1
fi

PADRAO="$HOME/servidores/$PACK_SLUG"
printf '  Pasta do servidor [Enter = %s]: ' "$PADRAO"
DESTINO=""
if ( : </dev/tty ) 2>/dev/null; then TEM_TERMINAL=1; else TEM_TERMINAL=0; fi
if [ "$TEM_TERMINAL" = 1 ] && [ ! -t 0 ]; then read -r DESTINO </dev/tty || true; else read -r DESTINO || true; fi
DESTINO="${DESTINO:-$PADRAO}"
mkdir -p "$DESTINO"
DESTINO="$(cd "$DESTINO" && pwd)"

TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
ARQUIVO_PACK="$TEMP/pack.mrpack"
if [ "${#OVERRIDES[@]}" -gt 0 ]; then
  echo "  Baixando o .mrpack para as configuracoes..."
  baixar "$PACK_URL" "$ARQUIVO_PACK"
  if [ -n "$PACK_SHA1" ] && [ "$(sha1sum "$ARQUIVO_PACK" | cut -d' ' -f1)" != "$PACK_SHA1" ]; then
    echo "  O hash do .mrpack não confere." >&2; exit 1
  fi
fi

MARCA_LOADER="$LOADER_NOME|$MC_VERSAO|$LOADER_VERSAO"
if [ "$(cat "$DESTINO/.modpackforge-loader" 2>/dev/null)" != "$MARCA_LOADER" ] ||
   { [ ! -f "$DESTINO/run.sh" ] && { [ -z "$LOADER_LANCADOR" ] || [ ! -f "$DESTINO/$LOADER_LANCADOR" ]; }; }; then
  echo "  Instalando $LOADER_NOME $LOADER_VERSAO..."
  baixar "$LOADER_URL" "$TEMP/$LOADER_JAR"
  ARGS=()
  for argumento in "${LOADER_ARGS[@]}"; do ARGS+=("${argumento//\{DIR\}/$DESTINO}"); done
  (cd "$DESTINO" && java -jar "$TEMP/$LOADER_JAR" "${ARGS[@]}")
  printf '%s\n' "$MARCA_LOADER" > "$DESTINO/.modpackforge-loader"
fi

echo "  Baixando ${#ARQUIVOS[@]} arquivos do servidor..."
baixar_arquivo() {
  local item="$1" caminho hash url destino
  IFS='|' read -r caminho hash url <<< "$item"
  destino="$DESTINO/$caminho"
  mkdir -p "$(dirname "$destino")"
  if [ -f "$destino" ] && [ "$(sha1sum "$destino" | cut -d' ' -f1)" = "$hash" ]; then
    echo "  Já estava aqui: $caminho"
    return 0
  fi
  if ! baixar "$url" "$destino.parcial"; then
    echo "  Falhou: $caminho" >&2
    rm -f "$destino.parcial"
    return 1
  fi
  if [ "$(sha1sum "$destino.parcial" | cut -d' ' -f1)" != "$hash" ]; then
    echo "  Hash incorreto: $caminho" >&2
    rm -f "$destino.parcial"
    return 1
  fi
  mv -f "$destino.parcial" "$destino"
  echo "  OK: $caminho"
}
for item in "${ARQUIVOS[@]}"; do
  { baixar_arquivo "$item" || touch "$TEMP/falhou"; } &
  while [ "$(jobs -rp | wc -l)" -ge 6 ]; do wait -n 2>/dev/null || true; done
done
wait
if [ -f "$TEMP/falhou" ]; then echo '  Instalacao incompleta. Rode novamente para tentar os arquivos que faltaram.' >&2; exit 1; fi
falhas=0

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
if [ "$falhas" -gt 0 ]; then echo '  Nao consegui aplicar todas as configuracoes. Rode novamente.' >&2; exit 1; fi

# Gerencia apenas os JARs que este instalador colocou, incluindo overrides.
# Remove versoes antigas e mods tirados do pack em uma nova exportacao.
REGISTRO="$DESTINO/.modpackforge-modpack-mods"
ESPERADOS="$TEMP/mods-esperados"
: > "$ESPERADOS"
for item in "${ARQUIVOS[@]}" "${OVERRIDES[@]}"; do
  IFS='|' read -r primeiro segundo resto <<< "$item"
  case "$primeiro" in overrides/*|server-overrides/*) caminho="$segundo" ;; *) caminho="$primeiro" ;; esac
  [[ "$caminho" == mods/*.jar ]] && printf '%s\n' "$caminho" >> "$ESPERADOS"
done
if [ -f "$REGISTRO" ]; then
  while IFS= read -r antigo; do
    [[ "$antigo" == mods/*.jar && "$antigo" != *'..'* && "$antigo" != *'\'* ]] || continue
    if ! grep -qxF "$antigo" "$ESPERADOS"; then rm -f -- "$DESTINO/$antigo"; fi
  done < "$REGISTRO"
fi
cp "$ESPERADOS" "$REGISTRO"

if [ ! -f "$DESTINO/server.properties" ]; then
  printf 'server-port=%s\nmotd=%s\nonline-mode=true\n' "$PORTA" "$PACK_NOME" > "$DESTINO/server.properties"
fi

if ! grep -qi '^eula=true' "$DESTINO/eula.txt" 2>/dev/null; then
  echo "  Para iniciar, leia https://aka.ms/MinecraftEULA"
  printf '  Digite aceito para concordar: '
  RESPOSTA=""
  if [ "$TEM_TERMINAL" = 1 ] && [ ! -t 0 ]; then read -r RESPOSTA </dev/tty || true; else read -r RESPOSTA || true; fi
  if [ "${RESPOSTA,,}" = 'aceito' ]; then printf 'eula=true\n' > "$DESTINO/eula.txt"; fi
fi

cat > "$DESTINO/iniciar.sh" <<INICIAR
#!/usr/bin/env bash
cd "\$(dirname "\$0")" || exit 1
if [ -f run.sh ]; then
  printf -- '-Xmx%sM -Xms1024M\n' "$MEMORIA_MB" > user_jvm_args.txt
  exec ./run.sh nogui "\$@"
fi
for jar in "$LOADER_LANCADOR" quilt-server-launch.jar fabric-server-launch.jar server.jar minecraft_server.jar; do
  if [ -n "\$jar" ] && [ -f "\$jar" ]; then exec java -Xmx${MEMORIA_MB}M -Xms1024M -jar "\$jar" nogui "\$@"; fi
done
echo 'Não achei o jar do servidor.' >&2
exit 1
INICIAR
chmod +x "$DESTINO/iniciar.sh"
[ ! -f "$DESTINO/run.sh" ] || chmod +x "$DESTINO/run.sh"
cat > "$DESTINO/verificacao-pack.txt" <<'MPF_RELATORIO'
@@VERIFICACAO@@
MPF_RELATORIO
cat > "$DESTINO/verificar-servidor.sh" <<'MPF_TESTE_BOOT'
@@VERIFICADOR@@
MPF_TESTE_BOOT
chmod +x "$DESTINO/verificar-servidor.sh"

echo ""
echo "  ${#EXCLUIDOS[@]} arquivos exclusivos do cliente ficaram de fora."
echo "  Pasta: $DESTINO"
echo "  Para iniciar: cd \"$DESTINO\" && ./iniciar.sh"
echo "  Para testar o boot: cd \"$DESTINO\" && bash verificar-servidor.sh"
echo '  Auditoria: verificacao-pack.txt. O teste de boot gera um log separado.'
echo "  Libere a porta TCP $PORTA no firewall da VPS se necessário."
if [ "$falhas" -gt 0 ]; then
  echo "  $falhas arquivos falharam. Rode o instalador novamente." >&2
  exit 1
fi
