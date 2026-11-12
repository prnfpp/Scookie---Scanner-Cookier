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

# Interfaccia di questo utente già aperta: basta mostrarla. Si riconosce dal file privato con indirizzo e chiave
# (~/.scookie/interfaccia.json); un'interfaccia di un altro utente sulla stessa porta non viene mai riusata.
SESSION="$HOME/.scookie/interfaccia.json"
if [ -f "$SESSION" ]; then
  URL="$(node -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.kill(s.pid, 0); console.log(s.url); } catch {}' "$SESSION" 2>/dev/null)"
  if [ -n "$URL" ] && [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL")" = "200" ]; then
    open "$URL" 2>/dev/null || true
    exit 0
  fi
fi

# Versione che non si è riusciti a installare o compilare in un avvio precedente: non la si riprova a ogni avvio,
# si aspetta la successiva.
SKIP_FILE="$DIR/.scookie-salta"
OLD="$(git rev-parse HEAD)"
UPDATED=0

notify "Controllo degli aggiornamenti…"
if git fetch -q origin "$BRANCH"; then
  NEW="$(git rev-parse "origin/$BRANCH" 2>/dev/null)"
  # package-lock.json riscritto da un'installazione precedente non è una modifica voluta: si ripristina
  git checkout -q -- package-lock.json 2>/dev/null || true
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    notify "Ci sono modifiche locali al codice: aggiornamento saltato"
  elif [ -n "$NEW" ] && [ "$NEW" = "$(cat "$SKIP_FILE" 2>/dev/null)" ]; then
    notify "L'ultima versione su GitHub non si è installata correttamente: si usa la versione attuale"
  elif git checkout -q "$BRANCH" && git merge -q --ff-only "origin/$BRANCH"; then
    if [ "$OLD" != "$(git rev-parse HEAD)" ]; then
      UPDATED=1
      notify "Scookie aggiornato all'ultima versione"
    fi
  else
    notify "Aggiornamento non riuscito: si usa la versione attuale"
  fi
else
  notify "GitHub non raggiungibile: si usa la versione attuale"
fi

# Componenti (npm), browser (Chromium di Playwright) e compilazione della versione in uso. Ogni passo si segna come
# fatto solo se è riuscito, così un passo fallito si riprova all'avvio successivo.
prepare() {
  local LOCK HEAD_NOW PW
  LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null)"
  if [ ! -d node_modules ] || [ "$LOCK" != "$(cat node_modules/.scookie-lock 2>/dev/null)" ]; then
    notify "Installazione dei componenti (qualche minuto la prima volta)…"
    if ! npm ci --no-audit --no-fund; then
      # ripiego: npm install può riscrivere package-lock.json, che va riportato com'era (altrimenti gli
      # aggiornamenti successivi verrebbero saltati per "modifiche locali")
      npm install --no-audit --no-fund || { git checkout -q -- package-lock.json 2>/dev/null; return 1; }
      git checkout -q -- package-lock.json 2>/dev/null || true
    fi
    echo "$LOCK" > node_modules/.scookie-lock
  fi
  PW="$(node -p 'require("./node_modules/playwright/package.json").version' 2>/dev/null)"
  if [ -z "$PW" ] || [ "$PW" != "$(cat node_modules/.scookie-browser 2>/dev/null)" ]; then
    notify "Installazione del browser di Scookie…"
    if npx playwright install chromium; then
      echo "$PW" > node_modules/.scookie-browser
    else
      # con un browser già installato da prima si può comunque lavorare; si riprova al prossimo avvio
      notify "Browser non installato (rete assente?): si riprova al prossimo avvio"
    fi
  fi
  HEAD_NOW="$(git rev-parse HEAD)"
  if [ ! -f dist/src/cli.js ] || [ "$HEAD_NOW" != "$(cat dist/.scookie-build 2>/dev/null)" ]; then
    npm run build || return 1
    echo "$HEAD_NOW" > dist/.scookie-build
  fi
  return 0
}

if ! prepare; then
  if [ "$UPDATED" = "1" ]; then
    # La versione appena scaricata non si installa o non compila: si torna a quella di prima, che funzionava
    notify "La nuova versione non si avvia: ripristino della versione precedente…"
    git rev-parse HEAD > "$SKIP_FILE"
    git checkout -q -- package-lock.json 2>/dev/null || true
    git reset -q --hard "$OLD"
    rm -f dist/.scookie-build
    prepare || { notify "Avvio non riuscito: vedi ~/Library/Logs/Scookie.log"; exit 1; }
  else
    notify "Installazione o compilazione non riuscita: vedi ~/Library/Logs/Scookie.log"
    exit 1
  fi
fi

notify "Apertura dell'interfaccia…"
exec node dist/src/cli.js interfaccia --porta "$PORT"
