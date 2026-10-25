#!/bin/bash
# Avvio di Scookie dall'icona sulla Scrivania: aggiorna da GitHub, installa e compila se serve, apre l'interfaccia.
# I dati dei clienti (clienti/) e le esecuzioni (runs/) sono fuori dal repository e non vengono toccati.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1
# percorso di node registrato da installa-icona-mac.sh (le app avviate dal Finder non vedono il PATH del Terminale)
[ -f "$DIR/.scookie-env" ] && . "$DIR/.scookie-env"
export GIT_TERMINAL_PROMPT=0
PORT=4777
BRANCH=main

notify() { osascript -e "display notification \"$1\" with title \"Scookie\"" >/dev/null 2>&1 || echo "$1"; }
echo "--- $(date '+%Y-%m-%d %H:%M:%S') avvio"

# Interfaccia già aperta: basta mostrarla
if curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/"; then
  open "http://127.0.0.1:$PORT/" 2>/dev/null || true
  exit 0
fi

notify "Controllo degli aggiornamenti…"
if git fetch -q origin "$BRANCH"; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    notify "Ci sono modifiche locali al codice: aggiornamento saltato"
  else
    OLD="$(git rev-parse HEAD)"
    if git checkout -q "$BRANCH" && git merge -q --ff-only "origin/$BRANCH"; then
      [ "$OLD" != "$(git rev-parse HEAD)" ] && notify "Scookie aggiornato all'ultima versione"
    else
      notify "Aggiornamento non riuscito: si usa la versione attuale"
    fi
  fi
else
  notify "GitHub non raggiungibile: si usa la versione attuale"
fi

LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null)"
if [ ! -d node_modules ] || [ "$LOCK" != "$(cat node_modules/.scookie-lock 2>/dev/null)" ]; then
  notify "Installazione dei componenti (qualche minuto la prima volta)…"
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund || { notify "Installazione non riuscita: vedi ~/Library/Logs/Scookie.log"; exit 1; }
  npx playwright install chromium || true
  echo "$LOCK" > node_modules/.scookie-lock
fi
HEAD_NOW="$(git rev-parse HEAD)"
if [ ! -f dist/src/cli.js ] || [ "$HEAD_NOW" != "$(cat dist/.scookie-build 2>/dev/null)" ]; then
  npm run build || { notify "Compilazione non riuscita: vedi ~/Library/Logs/Scookie.log"; exit 1; }
  echo "$HEAD_NOW" > dist/.scookie-build
fi

notify "Apertura dell'interfaccia…"
exec node dist/src/cli.js interfaccia --porta "$PORT"
