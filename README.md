# Scookie – audit tecnico di cookie e consenso

Scookie verifica come uno o più siti (domini e sottodomini) gestiscono cookie e tracciamenti rispetto al consenso dell'utente, e produce un report con le prove.

Il tool documenta **fatti tecnici** con evidenze ripetibili e li collega a riferimenti normativi da una tabella modificabile. **Non** esprime giudizi di conformità e **non** indica come rimediare: la valutazione spetta al consulente legale o al DPO.


> **Non sei uno sviluppatore?** Parti dalla [Guida passo passo](#guida-passo-passo-per-chi-non-è-tecnico): spiega come installare il tool, preparare un audit, scegliere le pagine, leggere il report e cosa considerare per il GDPR.

## Guida passo passo (per chi non è tecnico)

### In due parole

Scookie apre i siti che indichi con un browser "pulito" (come un visitatore che arriva per la prima volta), prova tre comportamenti (non tocca il banner, clicca "Rifiuta", clicca "Accetta") e registra cosa viene salvato nel browser e a chi vengono inviati dati. Alla fine crea un report con le prove. Si usa dal **Terminale** del proprio computer: si scrivono pochi comandi, sempre gli stessi.

### 1. Cosa serve (una volta sola)

- **Node.js** versione "LTS": si scarica da <https://nodejs.org> e si installa con le opzioni predefinite.
- **Git**: su Mac di solito c'è già (se manca, al primo comando `git` il Mac propone di installarlo); su Windows si scarica da <https://git-scm.com>.
- Un **editor di testo** per i file di configurazione: consigliato [Visual Studio Code](https://code.visualstudio.com) (gratuito). Evitare Word o TextEdit, che possono alterare il testo.
- Una connessione che esca **dall'Italia**: niente VPN estere durante gli audit (il tool lo controlla da solo).

### 2. Installazione (una volta sola)

Aprire il Terminale (Mac: ⌘ + spazio, scrivere "Terminale"; Windows: menu Start, "PowerShell") e incollare una riga alla volta, premendo Invio dopo ognuna:

```sh
git clone https://github.com/prnfpp/Scookie---Scanner-Cookier.git
cd Scookie---Scanner-Cookier
npm install
npx playwright install chromium
npm run build
```

Per aggiornare il tool in futuro, dalla stessa cartella: `git pull`, poi `npm install` e `npm run build`.

Ogni volta che si riapre il Terminale bisogna prima entrare nella cartella del tool: `cd Scookie---Scanner-Cookier`.

### 3. Preparare l'audit di un cliente

Ogni cliente ha un **file di configurazione** (formato YAML: testo semplice con rientri). Si parte dall'esempio:

```sh
mkdir clienti
cp config/esempio.yaml clienti/rossi.yaml
```

(su Windows al posto di `cp` si usa `copy`). La cartella `clienti/` resta solo sul computer: non viene mai pubblicata su GitHub.

Aprire `clienti/rossi.yaml` con l'editor e modificare almeno `cliente:` e l'elenco `siti:`. **Attenzione ai rientri**: usare spazi (non tabulazioni) e mantenere l'allineamento dell'esempio.

#### Scegliere il dominio e i sottodomini

Ogni sito o sottodominio è una voce dell'elenco `siti`, con il suo indirizzo completo:

```yaml
siti:
  - url: https://www.rossi.it/
  - url: https://shop.rossi.it/
  - url: https://blog.rossi.it/
```

Ogni voce viene analizzata a parte, con il suo campione di pagine; il report confronta poi i sottodomini tra loro (stesso banner? stesso gestore del consenso?).

#### Scegliere le pagine del campione

Ci sono tre modi, che si possono combinare:

**a) Automatico** (predefinito). Il tool legge la sitemap e i link della home, raggruppa le pagine per tipo (prodotti, blog, servizi…) e ne sceglie alcune per tipo. Si regola con `campionamento:`:

```yaml
campionamento:
  perTipo: 2        # pagine per ogni tipo
  maxPagine: 12     # massimo per sito
```

**b) Automatico più pagine scelte da te.** Le pagine in `pagineExtra` vengono visitate sempre, per esempio i passaggi di un preventivo o un modulo di contatto:

```yaml
  - url: https://www.rossi.it/
    pagineExtra:
      - /preventivo/step-1
      - /preventivo/step-2
      - https://www.rossi.it/contatti
```

**c) Solo pagine scelte da te.** Con `soloPagineExtra: true` il tool visita solo la home e le pagine indicate, senza scoperta automatica:

```yaml
  - url: https://www.rossi.it/
    soloPagineExtra: true
    pagineExtra:
      - /chi-siamo
      - /prodotti/divano-milano
      - /carrello
```

Per **escludere** sezioni dal campione automatico: `escludi: ["^/area-riservata", "^/en/"]` (inizio del percorso). Le pagine che il sito vieta ai robot nel file robots.txt sono escluse in automatico (`rispettaRobots: true`); quelle indicate in `pagineExtra` vengono visitate comunque, perché sono una scelta esplicita.

#### Se il banner non viene riconosciuto

Il tool riconosce da solo i gestori del consenso più diffusi e i pulsanti con testi come "Rifiuta", "Accetta", "Solo necessari". Se in un report compare "pulsante Rifiuta non trovato", si possono indicare i pulsanti a mano (chi ha dimestichezza con il browser li trova con "Ispeziona"):

```yaml
    banner:
      rifiuta: "#cookie-bar .btn-deny"
      accetta: "#cookie-bar .btn-accept"
```

#### Elenco dei cookie dichiarati

Se il gestore del consenso lo espone (es. OneTrust), il tool legge da solo l'elenco dei cookie dichiarati. Altrimenti si può preparare un file CSV (si fa anche con Excel, salvando in CSV) come [`config/dichiarati-esempio.csv`](config/dichiarati-esempio.csv) e indicarlo con `dichiarati: ./dichiarati-rossi.csv`.

### 4. Controllare, provare, lanciare

```sh
npm run scookie -- verifica-config -c clienti/rossi.yaml   # controlla che il file sia scritto bene
npm run scookie -- scopri -c clienti/rossi.yaml            # mostra quali pagine verrebbero visitate (1-2 minuti)
npm run scookie -- run -c clienti/rossi.yaml               # esegue l'audit
```

`scopri` serve a controllare il campione prima dell'audit vero e proprio: se mancano pagine importanti, aggiungerle in `pagineExtra`.

L'audit richiede alcuni minuti per sito (circa 3-5 minuti con le impostazioni dell'esempio). La prima riga indica il paese di uscita rilevato: deve essere **IT**.

### 5. Leggere il risultato

Ogni esecuzione crea una cartella in `runs/` con data, ora e nome del cliente:

- **`report.html`** (si apre con doppio clic) e **`report.pdf`**: il documento. Inizia con "Come leggere questo report", poi perimetro e metodo, sintesi, una scheda per ogni criticità con descrizione, prova e riferimenti normativi, l'inventario di cookie e terze parti, e l'elenco dei file con le impronte;
- **file `.csv`**: i dati grezzi, si aprono con Excel;
- **cartella `evidenze/`**: screenshot e registrazioni del traffico (file HAR);
- **`manifest.json`**: configurazione usata, versioni, impronte di ogni file.

**La cartella va conservata intera e senza modifiche**: le impronte SHA-256 servono proprio a dimostrare che i file non sono stati toccati dopo la raccolta.

### 6. Come usarlo bene

1. **Prima dell'audit** concordare con il cliente il perimetro (domini, sottodomini, pagine importanti come preventivi o checkout) e annotarlo nel file di configurazione.
2. **Eseguire l'audit due volte** a qualche minuto di distanza: se i risultati coincidono, sono stabili; se differiscono, il report lo mostra e va approfondito.
3. **Controllare a campione** le criticità più gravi aprendo il sito in un browser normale in finestra anonima.
4. **Consegnare** report e cartella al consulente legale o al DPO, che valuta la conformità. Il tool non dà indicazioni su come sistemare.
5. **Dopo le correzioni** del cliente, rilanciare lo stesso file di configurazione: il confronto tra i due report mostra cosa è cambiato.

### 7. Domande frequenti

**Il report ha valore legale?**
È una documentazione tecnica di parte, raccolta con un metodo descritto e ripetibile, con prove e impronte dei file. Non è una perizia giurata né un parere legale. Il suo valore come prova dipende da come viene usata: per un contenzioso conviene farla esaminare da un consulente tecnico e aggiungere una data certa, per esempio inviando l'archivio della cartella via PEC a sé stessi o facendolo marcare temporalmente da un servizio qualificato. Le "gravità" sono priorità di verifica suggerite, non qualificazioni giuridiche.

**Ci sono implicazioni GDPR nell'uso del tool?** (indicazioni tecniche, da far confermare al proprio consulente)
- Il tool visita **pagine pubbliche** con un browser nuovo e senza account: i cookie e gli identificativi registrati sono quelli assegnati al browser del tool, non a persone reali.
- Possono però finire nei file dati personali di terzi presenti sulle pagine (es. nomi negli screenshot) e l'indirizzo IP di chi esegue l'audit (nel report e nel manifest).
- Buone pratiche: conservare le cartelle in un luogo protetto, definire per quanto tempo tenerle, non pubblicarle, e se l'audit è svolto per un cliente regolare l'incarico per iscritto (compresa la gestione di questi file).
- Lo **step di login** (aree riservate), se verrà aggiunto, richiederà account di prova dedicati e cautele specifiche.

**Posso analizzare un sito che non è di un mio cliente?**
Tecnicamente sì, è come visitarlo con un browser. Il tool naviga lentamente, si dichiara nello user agent (`ScookieAudit`), rispetta robots.txt e non tenta di aggirare protezioni anti-bot. Valutare comunque con il proprio consulente l'uso che si intende fare dei risultati.

**Perché il paese di uscita è importante?**
Molti gestori del consenso mostrano banner diversi (o nessun banner) a seconda del paese del visitatore. Un audit fatto da una connessione estera non descrive l'esperienza di un utente italiano: per questo il tool si ferma se il paese non è quello atteso (`verificaUscita: blocca`).

**Il sito blocca il tool o il banner non compare.**
Alcuni siti grandi bloccano i browser automatici. Il report lo segnala (sessioni senza banner, richieste fallite) e il tool ripete una volta le sessioni sospette. Non si deve cercare di aggirare i blocchi: va annotato come limite dell'audit.

## Cosa fa (dettaglio tecnico)

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
2. **Adattatori dei CMP noti**, che cliccano i pulsanti reali: OneTrust, Cookiebot, iubenda, Didomi, Usercentrics, CookieYes, Complianz, HubSpot, vanilla-cookieconsent (diffuso nella PA). IAB TCF (`__tcfapi`) viene letto per la verifica;
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
| `banner-intermittente` | banner presente in alcune sessioni e non in altre, anche dopo la ripetizione automatica |
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
- banner in shadow DOM e in iframe;
- rifiuto raggiungibile solo dalle preferenze;
- tracciamento attivato dallo scroll;
- vanilla-cookieconsent il cui script non si carica alla prima visita (ripetizione automatica).

Il tool è stato inoltre validato su 5 siti reali (e-commerce, agenzia, PA, grande distribuzione) con esecuzioni ripetute dall'Italia e dagli USA: banner gestiti e verificati in tutti i casi in cui erano presenti, risultati coincidenti tra esecuzioni.

Chromium viene indirizzato al server locale con `--host-resolver-rules`, quindi non serve la rete.

## Licenze

Software proprietario, © 2026 Filippo Pirini (vedi [`LICENSE`](LICENSE)): nessuna licenza d'uso è concessa a terzi. Le dipendenze e i dati inclusi hanno licenze permissive, compatibili anche con software proprietario e commerciale. Dettagli ed esclusioni sono in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); `npm run licenses` li verifica automaticamente.

## Limiti noti

- Il controllo è campionario.
- Il tracciamento lato server non è osservabile oltre l'endpoint proprio.
- I risultati possono variare con geolocalizzazione, test A/B e aste pubblicitarie.
- I siti con protezioni anti-bot possono bloccare il browser automatizzato. Il tool naviga lentamente, dichiara lo user agent e non tenta di aggirare i blocchi.
- Non ancora implementati (in ordine di priorità suggerita):
  - interfaccia visuale locale per configurare e lanciare gli audit senza modificare file;
  - confronto automatico tra due esecuzioni (prima e dopo le correzioni del cliente);
  - marca temporale qualificata (RFC 3161) sul manifest, per dare data certa alle prove;
  - lettura automatica della pagina cookie policy;
  - rilevamento di identificativi senza cookie (fingerprint, ID nei parametri);
  - step di login per le aree riservate;
  - esportazione Excel nativa (i CSV si aprono già in Excel).

Report, HAR e configurazioni dei clienti **non** vanno nel repository (vedi `.gitignore`).
