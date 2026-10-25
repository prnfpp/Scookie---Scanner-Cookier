#!/bin/bash
# Crea l'icona "Scookie" sulla Scrivania: un doppio clic aggiorna il tool da GitHub e apre l'interfaccia.
# Da lanciare una volta dal Terminale, nella cartella del tool: npm run icona
set -e
[ "$(uname)" = "Darwin" ] || { echo "L'icona sulla Scrivania è disponibile solo su macOS."; exit 1; }
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node non trovato: installa Node.js e riprova."; exit 1; }

# Il Finder non vede il PATH del Terminale: si registra dove sono node e npm
echo "export PATH=\"$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:\$PATH\"" > "$DIR/.scookie-env"
chmod +x "$DIR/scripts/avvia-mac.sh"

APP="$HOME/Desktop/Scookie.app"
TMP="$(mktemp -d)"
cat > "$TMP/scookie.applescript" <<APPLESCRIPT
do shell script "/bin/bash " & quoted form of "$DIR/scripts/avvia-mac.sh" & " >> " & quoted form of (POSIX path of (path to home folder) & "Library/Logs/Scookie.log") & " 2>&1 &"
APPLESCRIPT
rm -rf "$APP"
osacompile -o "$APP" "$TMP/scookie.applescript"

# Icona
ICONSET="$TMP/scookie.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$DIR/assets/scookie.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$DIR/assets/scookie.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
touch "$APP"
rm -rf "$TMP"
echo "Fatto: sulla Scrivania c'è l'icona Scookie. Doppio clic per aggiornare il tool e aprire l'interfaccia."
echo "La prima volta macOS può chiedere conferma: tasto destro sull'icona > Apri."
