#!/usr/bin/env bash
# Testa o boot usando um mundo temporario e uma porta escolhida pelo sistema.
# Rode com o servidor principal parado. Nao aceita o EULA por voce.
set -euo pipefail
cd "$(dirname "$0")"
if ! grep -qi '^eula=true' eula.txt 2>/dev/null; then
  echo 'Aceite o EULA no instalador antes de testar.' >&2; exit 1
fi
for ferramenta in setsid mkfifo; do
  command -v "$ferramenta" >/dev/null || { echo "Preciso de $ferramenta." >&2; exit 1; }
done
LIMITE="${MPF_TEMPO_TESTE:-300}"
[[ "$LIMITE" =~ ^[0-9]+$ ]] && [ "$LIMITE" -ge 5 ] && [ "$LIMITE" -le 1800 ] || { echo 'Tempo de teste invalido (5 a 1800 segundos).'; exit 1; }
TEMP_TESTE="$(mktemp -d)"
LOG="verificacao-boot-$(date +%Y%m%d-%H%M%S).log"
PID=""
encerrar() {
  if [ -n "$PID" ] && kill -0 -- "-$PID" 2>/dev/null; then
    kill -TERM -- "-$PID" 2>/dev/null || true
    for ((n=0; n<20; n++)); do kill -0 -- "-$PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$PID" 2>/dev/null || true
  fi
  exec 3>&- 2>/dev/null || true
  rm -rf -- "$TEMP_TESTE"
}
trap encerrar EXIT
trap 'exit 130' INT TERM
mkfifo "$TEMP_TESTE/entrada"
exec 3<>"$TEMP_TESTE/entrada"
echo "Testando inicializacao (ate $LIMITE segundos). Log: $LOG"
echo 'O mundo do teste sera descartado; mantenha o servidor principal parado.'
setsid bash ./iniciar.sh --universe "$TEMP_TESTE/mundos" --world mpf-boot-test --port 0 <"$TEMP_TESTE/entrada" >"$LOG" 2>&1 &
PID=$!
INICIO=$SECONDS
ABRIU=0
while (( SECONDS - INICIO < LIMITE )); do
  if grep -Eq 'Done \([0-9.,]+s\)!' "$LOG"; then ABRIU=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if [ "$ABRIU" = 1 ]; then
  printf 'stop\n' >&3
  for ((n=0; n<30; n++)); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  if kill -0 "$PID" 2>/dev/null; then
    echo "O servidor abriu, mas nao encerrou normalmente. Confira $LOG." >&2; exit 1
  fi
  if ! wait "$PID"; then echo "O servidor abriu, mas terminou com erro. Confira $LOG." >&2; exit 1; fi
  echo "Boot confirmado e encerrado normalmente. Log: $LOG"
  echo 'O teste nao garante ausencia de falhas durante o jogo.'
else
  echo "Boot nao confirmado: crash, dependencia ausente ou tempo esgotado. Confira $LOG e crash-reports/." >&2
  tail -n 40 "$LOG" >&2
  exit 1
fi
