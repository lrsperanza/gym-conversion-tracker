#!/bin/sh
# Sobe uma tela virtual (o Cloudflare do EVO bloqueia Chrome headless) e roda a conferência.
# Cada passo loga, para o Cloud Logging mostrar onde parou se algo travar.
set -e
echo "[entrypoint] iniciando Xvfb em :99"
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=:99
i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 50 ]; do
	if ! kill -0 "$XVFB_PID" 2>/dev/null; then
		echo "[entrypoint] Xvfb morreu:"; cat /tmp/xvfb.log; exit 1
	fi
	i=$((i + 1)); sleep 0.2
done
if [ ! -e /tmp/.X11-unix/X99 ]; then
	echo "[entrypoint] Xvfb não abriu o display em 10s:"; cat /tmp/xvfb.log; exit 1
fi
echo "[entrypoint] Xvfb pronto; rodando bun src/check.ts $*"
set +e
bun src/check.ts "$@"
CODE=$?
kill "$XVFB_PID" 2>/dev/null
echo "[entrypoint] fim (exit $CODE)"
exit $CODE
