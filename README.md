# Scookie – audit tecnico di cookie e consenso

Scookie verifica come uno o più siti (domini e sottodomini) gestiscono cookie e tracciamenti rispetto al consenso dell'utente, e produce un report con le prove.

Il tool documenta **fatti tecnici** con evidenze ripetibili e li collega a riferimenti normativi da una tabella modificabile. **Non** esprime giudizi di conformità e **non** indica come rimediare: la valutazione spetta al consulente legale o al DPO.

## Cosa fa

Per ogni sito: scopre le pagine (robots.txt, sitemap, link interni, URL aggiunte a mano), ne estrae un campione per tipo e lo visita con un browser pulito in tre scenari:

| Scenario | Cosa succede |
| --- | --- |
| `nessuna-azione` | la pagina viene caricata e osservata senza toccare il banner |
| `rifiuta` | click su "Rifiuta", poi navigazione di altre pagine per vedere se la scelta è rispettata |
| `accetta` | click su "Accetta", poi navigazione di altre pagine |

Per ogni sessione registra tutti i cookie (anche HttpOnly), localStorage e sessionStorage di tutti i frame, e tutte le richieste di rete. Ogni elemento viene marcato *prima/terza parte* e con il momento in cui compare: *al caricamento* (nessuna interazione), *dopo lo scroll* (nessuna scelta sul banner) o *dopo la scelta*. Separare lo scroll serve per i banner che lo trattano come consenso. Le prove sono screenshot e file HAR, con hash SHA-256.

All'avvio il tool rileva IP e paese di uscita effettivi, passando dallo stesso browser e dallo stesso eventuale proxy, e li confronta con `paeseUscita`. Molti CMP mostrano il banner solo a visitatori da UE/SEE. Con `verificaUscita: blocca` l'esecuzione si ferma se il paese non corrisponde.

Domande a cui risponde, per ogni pagina:

1. Cosa si installa **prima** di qualsiasi scelta?
2. Dopo **"Rifiuta"** si attiva comunque qualcosa?
3. Dopo **"Accetta"** cosa si attiva?
4. Quello che si osserva corrisponde a quanto **dichiarato**? (non dichiarato, dichiarato ma mai visto, categoria incoerente)

## Requisiti e installazione

Node.js 20 o superiore.

```sh
npm install
npx playwright install chromium   # solo la prima volta
npm run build
```

## Uso

```sh
cp config/esempio.yaml clienti/cliente.yaml          # clienti/ è esclusa da git
npm run scookie -- verifica-config -c clienti/cliente.yaml  # controlla la configurazione
npm run scookie -- scopri -c clienti/cliente.yaml           # mostra il campione di pagine senza eseguire gli scenari
npm run scookie -- run -c clienti/cliente.yaml              # audit completo
```

Per la validazione su siti reali c'è già [`config/validazione.yaml`](config/validazione.yaml).

Opzioni di `run`: `--out <cartella>` per cambiare la cartella di output, `--no-pdf` per saltare il PDF.

Tutto si regola dal file YAML, senza toccare il codice. I campi sono commentati in [`config/esempio.yaml`](config/esempio.yaml) e definiti in [`src/config/schema.ts`](src/config/schema.ts).

## Output

Una cartella per esecuzione (`runs/<data>_<cliente>/`):

| File | Contenuto |
| --- | --- |
| `report.html`, `report.pdf` | il documento da consegnare: perimetro e metodo, sintesi, schede delle criticità con prove e norme, inventario, allegati |
| `cookie.csv`, `storage.csv`, `richieste.csv`, `sessioni.csv` | dati grezzi per sessione (separatore `;`, si aprono in Excel) |
| `confronto-dichiarati.csv` | confronto tra elementi osservati ed elenco dichiarato |
| `criticita.csv` | elenco delle criticità |
| `dati.json` | tutti i dati in formato strutturato |
| `evidenze/` | screenshot e HAR per sessione (i HAR conservano sempre i corpi delle richieste; dei corpi delle risposte, per default solo i testuali fino a 512 KB: vedi `report.harContenuti`); in `evidenze/criticita/` le prove con il numero della criticità nel nome (`C-003_…png`) |
| `manifest.json` (+ `.sha256`) | configurazione usata, versione del tool, browser, user agent, hash di ogni file |

## Come interagisce con banner che non conosce

Per ogni scelta prova, nell'ordine:

1. **Selettori manuali** della configurazione (`banner:` nel sito), se presenti;
2. **Adattatori dei CMP noti**, che cliccano i pulsanti reali: OneTrust, Cookiebot, iubenda, Didomi, Usercentrics, CookieYes, Complianz, HubSpot. IAB TCF (`__tcfapi`) viene letto per la verifica;
3. **Euristica** sui testi dei pulsanti ("Rifiuta", "Solo necessari", "Continua senza accettare", la X…), anche dentro iframe e shadow DOM. Se il rifiuto non c'è al primo livello, apre le preferenze e lo cerca lì;
4. **API del CMP** (es. `OneTrust.RejectAll()`), solo come ultimo ripiego. Il report lo segnala, perché non equivale al click di un utente.

Dopo la scelta legge lo stato del consenso dal CMP (gruppi attivi OneTrust, `Cookiebot.consent`, stringa TCF…) e lo confronta con la scelta fatta. Il report dice sempre quale metodo ha funzionato, a quale livello del banner (primo, secondo, chiusura X) e cosa non è stato trovato.

## Regole di criticità

| Regola | Cosa rileva |
| --- | --- |
| `cookie-prima-del-consenso` | cookie o storage non tecnici prima della scelta |
| `richiesta-tracker-prima-del-consenso` | richieste a pubblicità, statistica, registrazione sessioni, social prima della scelta |
| `consent-mode-senza-consenso` | ping Google Consent Mode con `gcs=G100` prima della scelta o dopo il rifiuto |
| `attivazione-dopo-rifiuto` | cookie o richieste di tracciamento dopo "Rifiuta", anche nelle pagine successive |
| `rifiuto-non-al-primo-livello` | rifiuto solo nelle preferenze, solo via API, o non trovato |
| `scelta-non-verificata` | stato del consenso registrato non coerente con la scelta |
| `banner-assente` | nessun banner né CMP rilevato |
| `sottodomini-disomogenei` | sottodomini con CMP diversi o senza banner; cookie policy su altro host |
| `elementi-non-dichiarati` | elementi osservati assenti dall'elenco dichiarato |
| `dichiarati-non-osservati` | voci dichiarate mai osservate |
| `categoria-incoerente` | es. analytics o heatmap tra i "necessari / sempre attivi"; stesso cookie in più categorie |
| `elementi-non-classificati` | cookie, storage e domini di terze parti che nessuna fonte sa classificare: vengono elencati invece di restare invisibili |
| `endpoint-server-side` | endpoint di raccolta su dominio proprio (`/g/collect`…), con il limite che comporta |

Norme collegate e gravità si cambiano in [`config/norme.yaml`](config/norme.yaml). I riferimenti precaricati vanno **validati dal consulente legale**.

## Elenco dichiarato

In ordine di precedenza:
1. il file indicato in `dichiarati:` per il sito, in CSV o YAML (vedi [`config/dichiarati-esempio.csv`](config/dichiarati-esempio.csv));
2. le API del CMP (`OneTrust.GetDomainData()`, `UC_UI.getServicesBaseInfo()`).

I nomi con segnaposto (`_ga_xxxxxxx`, `_ga_*`, `_hjSession_<id>`) sono riconosciuti come pattern.

## Estendere

- **Nuovo CMP:** creare un modulo in `src/cmp/adapters/` (vedi `cookiebot.ts` come esempio: selettori, espressione per lo stato, verifica) e aggiungerlo in `src/cmp/registry.ts`.
- **Nuova regola:** creare un modulo in `src/rules/regole/` che implementa `Rule` e aggiungerlo in `src/rules/index.ts`. Collegare le norme in `config/norme.yaml`.
- **Nuovi domini tracker:** senza toccare il codice, con un file YAML indicato in `trackerExtra:` (stesso formato di `data/trackers.yaml`).

## Test

```sh
npm test
```

I test di integrazione usano siti di prova locali (`test/fixtures/sites/`), uno per caso tipico:

- banner sconosciuto con tracciamenti prima della scelta e dopo il rifiuto;
- OneTrust con rifiuto solo al secondo livello e Hotjar tra i "necessari";
- sottodominio senza banner;
- banner in shadow DOM;
- banner in iframe.

Chromium viene indirizzato al server locale con `--host-resolver-rules`, quindi non serve la rete.

## Licenze

Software proprietario, © 2026 Filippo Pirini (vedi [`LICENSE`](LICENSE)): nessuna licenza d'uso è concessa a terzi. Le dipendenze e i dati inclusi hanno licenze permissive, compatibili anche con software proprietario e commerciale. Dettagli ed esclusioni sono in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); `npm run licenses` li verifica automaticamente.

## Limiti noti

- Il controllo è campionario.
- Il tracciamento lato server non è osservabile oltre l'endpoint proprio.
- I risultati possono variare con geolocalizzazione, test A/B e aste pubblicitarie.
- I siti con protezioni anti-bot possono bloccare il browser automatizzato. Il tool naviga lentamente, dichiara lo user agent e non tenta di aggirare i blocchi.
- Non ancora implementati:
  - lettura automatica della pagina cookie policy;
  - rilevamento di identificativi senza cookie (fingerprint, ID nei parametri);
  - step di login;
  - esportazione Excel nativa (i CSV si aprono in Excel).

Report, HAR e configurazioni dei clienti **non** vanno nel repository (vedi `.gitignore`).
