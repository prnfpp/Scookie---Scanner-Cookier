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

**Icona sulla Scrivania (Mac, consigliata).** Sempre dalla cartella del tool:

```sh
npm run icona
```

Sulla Scrivania compare l'icona **Scookie**. Il doppio clic controlla gli aggiornamenti su GitHub e li installa (scarica, aggiorna i componenti se servono, ricompila), poi apre l'interfaccia nel browser: non serve più il Terminale. La prima volta macOS può chiedere conferma: tasto destro sull'icona > Apri. Se Scookie è già aperto, il doppio clic mostra semplicemente l'interfaccia. Il registro dell'avvio è in `~/Library/Logs/Scookie.log`. Le configurazioni dei clienti (`clienti/`) e i risultati (`runs/`) non sono toccati dagli aggiornamenti.

Senza icona, per aggiornare il tool dalla stessa cartella: `git pull`, poi `npm install` e `npm run build`.

Ogni volta che si riapre il Terminale bisogna prima entrare nella cartella del tool: `cd Scookie---Scanner-Cookier`.

### 3. Il modo più semplice: l'interfaccia visuale

Dalla cartella del tool:

```sh
npm run interfaccia
```

Si apre il browser su una pagina di Scookie (indirizzo `http://127.0.0.1:4777`). La pagina funziona solo sul tuo computer: non è pubblicata su internet e i dati dei clienti restano in locale. Il Terminale deve restare aperto finché si usa l'interfaccia; per chiuderla, `Ctrl+C` nel Terminale.

Nell'interfaccia ci sono tre schede in alto: **Clienti**, **Audit** ed **Esecuzioni**. In alto a destra un indicatore mostra sempre se un audit è in corso e a che punto è.

- **Clienti**: una scheda per cliente, con i siti e l'esito dell'ultimo audit. **+ Nuovo cliente** apre il modulo, diviso in quattro passi:
  1. **Siti**: nome del cliente, poi uno o più siti (dominio e sottodomini). Per ogni sito si sceglie quali pagine controllare: in automatico, in automatico più alcune indicate a mano, oppure solo quelle indicate a mano. In "Opzioni avanzate del sito" si trovano cookie policy, file dei cookie dichiarati e pulsanti del banner da indicare a mano.
  2. **Opzioni**: scenari, numero di ripetizioni (1–3), paese di uscita; in "Opzioni avanzate" numero di pagine, HAR, PDF e browser visibile.
  3. **Controllo**: **Anteprima pagine** mostra quali pagine verrebbero visitate, e una lista ricorda cosa verificare prima di partire.
  4. **Avvio**: durata stimata e pulsante **Avvia audit**.
- **Salva**: le configurazioni sono gli stessi file YAML della cartella `clienti/` descritti sotto, quindi si possono usare anche dal Terminale.
- **Audit**: barra di avanzamento con **tempo rimanente stimato** (calcolato sulla durata media delle sessioni già fatte), fase in corso, avanzamento per sito. Se serve una navigazione manuale compare "Azione richiesta"; se la connessione cade, l'audit si mette in pausa e riprende da solo. Alla fine: **Apri il report**, PDF e **Revisiona le schede**.
- **Esecuzioni**: tutti i report passati, con il conteggio delle schede per gravità e i quattro passi Leggi → Revisiona → Rivisto → Confronta. La revisione delle schede si fa direttamente nell'interfaccia (esito e nota per scheda), senza aprire Excel. Se un sito non ha dati (pagine non caricate), il pulsante **Ripeti solo questi siti** rilancia l'audit solo per quelli. Il paese di uscita è evidenziato in rosso se non è l'Italia.

In fondo alla scheda Clienti, il riquadro **Programma** dice se ci sono aggiornamenti su GitHub: **Aggiorna e riavvia** li installa e riapre l'interfaccia (se Scookie è stato aperto dall'icona), **Chiudi Scookie** lo chiude.

**Il computer resta sveglio durante l'audit.** Un audit completo può durare più di un'ora: per tutta la durata il tool impedisce lo stop per inattività (su Mac con `caffeinate`), anche se non tocchi il computer. Non chiudere il coperchio del portatile: con il coperchio chiuso il Mac va comunque in stop, salvo con alimentatore e monitor esterno collegati.

Le sezioni 4 e 5 descrivono le stesse operazioni dal Terminale, utili anche per capire le opzioni del file di configurazione.

### 4. Preparare l'audit di un cliente (dal Terminale)

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

#### Pagine che non sono nella sitemap (applicazioni web)

Alcuni siti, come le aree preventivo o le applicazioni web, non hanno sitemap né link: si cambia pagina cliccando pulsanti. Se con sitemap e link il tool trova meno di 5 pagine, prova da solo un'**esplorazione con clic**: apre la home e le pagine extra, clicca pulsanti, menu e schede dello stesso sito (fino a 2 livelli, 40 clic, 25 pagine, 4 minuti) e aggiunge al campione gli indirizzi che compaiono. Le pagine trovate così hanno origine "esplorazione" nel report. Durante l'esplorazione può passare per gli altri sottodomini dello stesso dominio (es. da www.esempio.it all'area preventivo su app.esempio.it), ma nel campione entrano solo le pagine del sito in esame. Se compare una verifica anti-bot si ferma subito.

Non clicca mai: le scelte sul banner dei cookie, i pulsanti che inviano moduli, e quelli come "Esci", "Paga", "Acquista", "Elimina", "Conferma", "Iscriviti". Non compila moduli: nei percorsi come il preventivo arriva al primo passaggio, i successivi vanno indicati in `pagineExtra`. L'esplorazione usa un browser separato, quindi non altera i dati dell'audit, ed è ripetibile (stesso ordine di clic a ogni esecuzione).

```yaml
  - url: https://app.esempio.it/
    esplora: sempre        # auto (predefinito) | sempre | no
```

I limiti si cambiano in `campionamento.esplorazione` (`sePaginaMeno`, `profondita`, `maxClic`, `maxPagine`, `maxSecondi`). Nell'interfaccia: "Opzioni avanzate del sito" → "Esplorazione con clic".

#### Percorsi da fare a mano (es. il preventivo)

Alcuni percorsi richiedono di compilare moduli (targa, data di nascita…) e il tool non li fa da solo. Per questi c'è la **navigazione manuale assistita**, che si attiva scrivendo le istruzioni nel campo "Navigazione manuale" del sito (non parte da sola). Le navigazioni manuali si fanno **tutte all'inizio dell'audit**, subito dopo la scoperta delle pagine: dopo, l'audit prosegue da solo e puoi lasciare il computer. Nell'interfaccia compare l'avviso "Azione richiesta" finché non premi "Ho finito".

Come funziona: il browser si apre in una finestra, il tool esegue la scelta sul banner (es. "Rifiuta"), poi un riquadro in basso a sinistra mostra le istruzioni e tu navighi a mano. Quando hai finito premi **"Ho finito"** nel riquadro (oppure **"Ho finito la navigazione"** nella scheda Audit dell'interfaccia, se il riquadro non si vede). Solo le navigazioni manuali hanno una finestra: scoperta delle pagine e sessioni automatiche restano senza finestra, così il computer resta utilizzabile. Tutto quello che succede viene registrato come nelle altre sessioni (cookie, richieste, HAR, screenshot) e le regole lo valutano allo stesso modo; il report elenca le pagine che hai percorso.

```yaml
  - url: https://app.esempio.it/
    navigazioneManuale:
      istruzioni: "Compila il preventivo auto con la targa di prova AB123CD fino alla pagina del prezzo"
      partenza: /preventivo            # facoltativa
      scenari: [rifiuta, accetta]      # predefinito; anche nessuna-azione
      maxMinuti: 10                    # poi la sessione si chiude da sola
```

**Percorso registrato.** Durante la navigazione manuale il tool registra i tuoi clic e i campi che compili (non le azioni sul banner dei cookie). Alla fine il percorso si salva accanto alla configurazione (`clienti/percorsi/`): **dalle esecuzioni successive si rigioca da solo**, dopo la scelta sul banner, in ogni ripetizione e senza operatore. Così anche il flusso del preventivo risulta "osservato in 3 su 3". Il report dice in quante sessioni il percorso è stato completato; se il sito cambia e un passo non si trova più, la sessione lo segnala. Per rifarlo: nell'interfaccia, scheda del sito, **Registra di nuovo** (oppure si elimina il file in `clienti/percorsi/`).

**Dati di prova.** Indica nella configurazione i dati che inserisci nei moduli (nell'interfaccia: passo Opzioni, "Dati di prova delle navigazioni manuali"):

```yaml
datiDiProva:
  targa: AA123BB
  dataNascita: 01/01/1990
  email: test.audit@esempio.it
```

Il tool li riconosce in ogni forma (es. la data come `01/01/1990` o `1990-01-01`, anche dentro un indirizzo codificato) come **prova certa** che quei dati arrivano a un terzo, e li riporta in chiaro (sono fittizi o concordati). I valori che soltanto somigliano a dati personali restano mascherati e hanno certezza più bassa.

Non toccare il banner dei cookie durante la navigazione manuale. **Usa una targa e dati concordati col cliente o palesemente fittizi**: i moduli inviati arrivano davvero al sito, e se il sito li mette negli indirizzi delle pagine possono finire a terze parti (la regola `dati-personali-a-terzi` lo rileva). Nel report e nei CSV i valori compaiono solo mascherati (es. `AB•••CD`); in chiaro restano solo nei file HAR. Nell'interfaccia il campo è nella scheda del sito, sotto le pagine da includere.

#### Se il sito blocca il tool

Alcuni siti mostrano ai browser automatici una pagina di verifica ("Verifica di essere umano", Cloudflare, DataDome…). Il tool la riconosce: la sessione viene **scartata** (non produce criticità sul sito) e il report lo dichiara nella scheda "Accesso bloccato" e nella sintesi. Si può riprovare con il browser visibile:

```yaml
browser:
  headless: false     # il browser si apre sullo schermo durante l'audit
  canale: chrome      # facoltativo: usa Google Chrome installato sul computer
```

Nell'interfaccia sono le opzioni "Browser" e "Mostra il browser durante l'audit". Il tool non tenta di superare le verifiche: se il blocco resta, va annotato come limite.

Per capire se le verifiche anti-bot alterano i risultati si può fare un'**esecuzione di controllo** con `uaNormale: true` (insieme a `headless: false`): lo user agent è quello di un browser normale, senza "HeadlessChrome" e senza la dichiarazione dell'audit. Il report lo indica. Confrontando le due esecuzioni ("Confronta con precedente") si vede cosa cambia.

#### Se il banner non viene riconosciuto

Il tool riconosce da solo i gestori del consenso più diffusi e i pulsanti con testi come "Rifiuta", "Accetta", "Solo necessari". Se in un report compare "pulsante Rifiuta non trovato", si possono indicare i pulsanti a mano (chi ha dimestichezza con il browser li trova con "Ispeziona"):

```yaml
    banner:
      rifiuta: "#cookie-bar .btn-deny"
      accetta: "#cookie-bar .btn-accept"
```

#### Elenco dei cookie dichiarati

Se il gestore del consenso lo espone (es. OneTrust), il tool legge da solo l'elenco dei cookie dichiarati. Altrimenti prova a leggerlo dalle tabelle della pagina di cookie policy: quella indicata in `cookiePolicy:` per il sito, oppure quella collegata dal banner. Se nemmeno così si trova, si può preparare un file CSV (si fa anche con Excel, salvando in CSV) come [`config/dichiarati-esempio.csv`](config/dichiarati-esempio.csv) e indicarlo con `dichiarati: ./dichiarati-rossi.csv`.

### 5. Controllare, provare, lanciare

```sh
npm run scookie -- verifica-config -c clienti/rossi.yaml   # controlla che il file sia scritto bene
npm run scookie -- scopri -c clienti/rossi.yaml            # mostra quali pagine verrebbero visitate (1-2 minuti)
npm run scookie -- run -c clienti/rossi.yaml               # esegue l'audit
```

`scopri` serve a controllare il campione prima dell'audit vero e proprio: se mancano pagine importanti, aggiungerle in `pagineExtra`.

L'audit richiede alcuni minuti per sito (circa 3-5 minuti con le impostazioni dell'esempio). La prima riga indica il paese di uscita rilevato: deve essere **IT**.

### 6. Leggere il risultato

Ogni esecuzione crea una cartella in `runs/` con data, ora e nome del cliente:

- **`report.html`** (si apre con doppio clic) e **`report.pdf`**: il documento. Inizia con "Come leggere questo report" e una **sintesi per il legale** di una o due pagine (le criticità principali in parole semplici), poi perimetro e metodo, analisi del banner, una scheda per ogni criticità con descrizione, prova e riferimenti normativi, l'inventario di cookie e terze parti, e l'elenco dei file con le impronte;
- **file `.csv`**: i dati grezzi, si aprono con Excel;
- **cartella `evidenze/`**: screenshot e registrazioni del traffico (file HAR);
- **`manifest.json`**: configurazione usata, versioni, impronte di ogni file.

Ogni scheda indica la **forza della prova**: *risorsa scaricata* (es. lo script di un fornitore, che da solo non dimostra una raccolta di dati), *dati inviati* (una richiesta di raccolta, es. un pixel con parametri) o *identificativo memorizzato* (un cookie o uno storage del fornitore). Le stesse criticità osservate su più sottodomini sono riunite in un'unica scheda.

**Il computer deve restare acceso, sveglio e collegato a internet** per tutta la durata dell'audit (vedi le domande frequenti). Se la connessione cade o il computer va in stop, le sessioni coinvolte vengono riconosciute come non valide: il tool aspetta il ripristino della connessione e le ripete; se non riesce, le esclude dalle regole e il report lo dichiara in apertura.

**La cartella va conservata intera e senza modifiche**: le impronte SHA-256 servono proprio a dimostrare che i file non sono stati toccati dopo la raccolta.

### 7. Come usarlo bene

1. **Prima dell'audit** concordare con il cliente il perimetro (domini, sottodomini, pagine importanti come preventivi o checkout) e annotarlo nel file di configurazione.
2. **Ripetere gli scenari** con `scenari.ripetizioni: 2` o `3` (nell'interfaccia: passo Opzioni). Ogni scheda riporta "Osservato in k su N esecuzioni": un fatto visto 3 volte su 3 è stabile, uno visto 1 volta su 3 va approfondito. I fatti visti solo nella navigazione manuale (che si fa una volta) sono indicati come tali. Anche l'analisi del banner si ripete in ogni esecuzione.
3. **Controllare a campione** le criticità più gravi aprendo il sito in un browser normale in finestra anonima.
4. **Consegnare** report e cartella al consulente legale o al DPO, che valuta la conformità. Il tool non dà indicazioni su come sistemare.
5. **Revisionare le schede** prima di consegnare: in ogni esecuzione c'è il file `revisione.csv` (si apre con Excel), con una riga per scheda. Nella colonna `esito` scrivi `confermato`, `falso positivo` o `da verificare`, e nella colonna `nota` il motivo. Poi, nell'interfaccia, **Applica revisione** (oppure `npm run scookie -- revisione runs/<cartella>`): nasce `report-rivisto.html`/`.pdf`, con l'esito accanto a ogni scheda e i falsi positivi spostati in coda. Il report originale, i dati e le prove non cambiano. Nell'esecuzione successiva dello stesso cliente il modulo arriva già compilato per le schede uguali.
6. **Dopo le correzioni** del cliente, rilanciare lo stesso file di configurazione e confrontare le due esecuzioni: nell'interfaccia, scheda Esecuzioni, pulsante **Confronta con precedente**; dal Terminale `npm run scookie -- confronta runs/<prima> runs/<dopo>`. Il confronto elenca le criticità non più osservate, quelle nuove e quelle ancora presenti (con l'eventuale cambio di gravità).

### 8. Domande frequenti

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

**Posso lasciare l'audit andare da solo?**
Sì, dopo le eventuali navigazioni manuali (che si fanno all'inizio). Si può chiudere la scheda dell'interfaccia, ma non il Terminale, e il computer non deve andare in stop. Su Mac: `caffeinate -i npm run interfaccia` (il coperchio va lasciato aperto, salvo con alimentazione e schermo esterno). Su Windows: Impostazioni → Sistema → Alimentazione → sospensione "Mai" quando è collegato alla corrente, e "Quando chiudo il coperchio: non fare nulla".

**Il sito blocca il tool o il banner non compare.**
Alcuni siti grandi bloccano i browser automatici. Il report lo segnala (sessioni senza banner, richieste fallite) e il tool ripete una volta le sessioni sospette. Non si deve cercare di aggirare i blocchi: va annotato come limite dell'audit.

## Cosa fa (dettaglio tecnico)

Per ogni sito: scopre le pagine (robots.txt, sitemap, link interni, URL aggiunte a mano e, se servono, esplorazione con clic), ne estrae un campione per tipo e lo visita con un browser pulito in cinque scenari (si possono ridurre con `scenari.attivi`):

| Scenario | Cosa succede |
| --- | --- |
| `nessuna-azione` | la pagina viene caricata e osservata senza toccare il banner; al termine si analizza la struttura del banner |
| `rifiuta` | click su "Rifiuta", poi navigazione di altre pagine per vedere se la scelta è rispettata |
| `accetta` | click su "Accetta", poi navigazione di altre pagine |
| `personalizza` | dalle preferenze si attiva solo la categoria statistica e si verifica che non partano marketing e simili (adattatori per OneTrust, Cookiebot, vanilla-cookieconsent; per gli altri banner, compreso HubSpot, dall'interfaccia con l'euristica) |
| `revoca` | si accetta, si naviga, poi si riapre il banner dal comando "preferenze cookie" (testo, icona del CMP o link a una pagina come `/preferenze-cookies`, anche trovata nella sitemap) e si rifiuta. Se nessun comando c'è, la revoca è simulata via API del CMP e il report lo dichiara come prova più debole; se dopo la revoca succede lo stesso che dopo il rifiuto, non è contato come fatto nuovo |

**Percorso identico**: in tutti gli scenari, dopo la scelta si ricarica la pagina di partenza e si visitano le stesse pagine, nello stesso ordine. Nella revoca, dopo aver revocato, si rifà lo stesso percorso. Così "dopo il rifiuto", "dopo l'accettazione" e "dopo la revoca" confrontano le stesse pagine. Dopo la revoca si distingue l'**invio residuo** (richieste partite dalla pagina in cui si è revocato, entro pochi istanti: gravità bassa) dalla **nuova raccolta** nelle pagine visitate dopo.

**Ripetizioni**: con `scenari.ripetizioni` (1–3) ogni scenario si ripete N volte con un browser pulito; le regole si valutano su ogni ripetizione e la scheda dice in quante è stata osservata.

Il report descrive sempre l'elemento esatto cliccato (es. `pulsante "Rifiuta tutti" (#onetrust-reject-all-handler)`), così si distingue un vero "Rifiuta" da una X di chiusura o da un "Continua senza accettare".

**Analisi del banner**: pulsanti presenti al primo livello (accetta, rifiuta, preferenze, chiusura), link alla cookie policy, categorie già attive quando si aprono le preferenze (comprese quelle "sempre attive"), presenza di un comando per riaprire le preferenze fuori dal banner (cercato in tutta la pagina; il fondo pagina viene fotografato come prova). Per i comandi di accettazione e rifiuto misura l'**evidenza visiva**, al primo livello e nel pannello delle preferenze: pulsante con sfondo pieno o link, superficie (es. "4,3 volte più grande"), dimensione del testo e posizione nel banner. Il contrasto (formula WCAG) è riportato solo come leggibilità del testo, non come misura di evidenza. Gli interruttori delle preferenze si leggono solo dentro il contenitore del CMP (es. `#onetrust-pc-sdk`), non dai moduli della pagina. Le preferenze vengono aperte a fine sessione, dopo aver fermato la registrazione, quindi non alterano i dati raccolti.

**Classificazione**: un cookie è riconosciuto per nome **e** dominio (es. `sessionId` di Stonly non viene scambiato per quello di Instagram; `__cf_bm` e `cf_clearance` sono cookie tecnici di Cloudflare). Prima si consulta l'elenco curato [`data/cookies.yaml`](data/cookies.yaml), poi Open Cookie Database filtrato per dominio. Un nome sconosciuto scritto sul dominio di un fornitore noto **non** viene attribuito a quel fornitore: resta "da valutare", con il fornitore del dominio come indizio (es. una chiave di Cloudflare dentro il lettore Vimeo). I percorsi `/cdn-cgi/` di Cloudflare (verifica anti-bot) sono tecnici su qualsiasi sito. Una terza parte sconosciuta contattata prima della scelta è segnalata con gravità media.

**Consent Mode nella sintesi**: per le richieste a Google il titolo dice se avvengono con `ad_storage` negato (senza cookie pubblicitari) o senza alcun segnale di consenso (Consent Mode non impostato). Per i cookie prima della scelta dice se il sito li dichiara "sempre attivi" o non li dichiara.

**Consent Mode**: i parametri `gcs` e `gcd` delle richieste Google sono tradotti in chiaro (es. `gcs=G101: ad_storage negato, analytics_storage concesso`).

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
npm run interfaccia                                         # interfaccia visuale locale (http://127.0.0.1:4777)
```

L'interfaccia (`src/ui/server.ts`, pagina in `ui/index.html`) ascolta solo su `127.0.0.1`, verifica l'intestazione Host (contro il DNS rebinding) e accetta le chiamate solo con un cookie di sessione `SameSite=Strict` e un'intestazione dedicata. Opzioni: `--clienti <cartella>`, `--esecuzioni <cartella>`, `--porta <numero>`, `--no-apri`.

Per la validazione su siti reali c'è già [`config/validazione.yaml`](config/validazione.yaml).

Opzioni di `run`: `--out <cartella>` per cambiare la cartella di output, `--no-pdf` per saltare il PDF.

Confronto tra due esecuzioni: `npm run scookie -- confronta <cartella-prima> <cartella-dopo> [-o file.html]`. Le criticità sono abbinate per regola, oggetto e dominio (non per numero di scheda); il file va nella cartella della seconda esecuzione.

Tutto si regola dal file YAML, senza toccare il codice. I campi sono commentati in [`config/esempio.yaml`](config/esempio.yaml) e definiti in [`src/config/schema.ts`](src/config/schema.ts).

## Output

Una cartella per esecuzione (`runs/<data>_<cliente>/`):

| File | Contenuto |
| --- | --- |
| `report.html`, `report.pdf` | il documento da consegnare: perimetro e metodo, sintesi per il legale (i fatti raggruppati per causa e ordinati per gravità, forza della prova e ripetibilità), schede delle criticità con prove e norme, inventario, allegati |
| `cookie.csv`, `storage.csv`, `richieste.csv`, `sessioni.csv` | dati grezzi per sessione (separatore `;`, si aprono in Excel) |
| `confronto-dichiarati.csv` | confronto tra elementi osservati ed elenco dichiarato |
| `criticita.csv` | elenco delle criticità |
| `revisione.csv` | modulo per la revisione manuale delle schede (esito e nota); con `revisione` produce `report-rivisto.html`/`.pdf` e `revisione-applicata.json` (impronte) |
| `dati.json` | tutti i dati in formato strutturato |
| `evidenze/` | screenshot e HAR per sessione, compressi (`.har.gz`: su Mac un doppio clic restituisce il `.har`). I HAR conservano sempre i corpi delle richieste; i corpi delle risposte (per default solo i testuali fino a 512 KB: vedi `report.harContenuti`) restano solo per le sessioni citate nelle schede. Con `report.harCompressi: false` i HAR restano interi e non compressi. In `evidenze/criticita/` le prove con il numero della criticità nel nome (`C-003_…png`) |
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
| `accesso-bloccato` | pagina di verifica anti-bot al posto del sito: le sessioni sono escluse dalle regole |
| `struttura-banner` | primo livello senza un pulsante di rifiuto (solo accetta, preferenze o X) |
| `categorie-preattivate` | categorie non tecniche già attive all'apertura delle preferenze |
| `categorie-non-presentate` | OneTrust: categorie configurate con cookie associati che non compaiono nel pannello delle preferenze (fatto documentale) |
| `tecnico-solo-dopo-consenso` | elementi dichiarati **solo** tecnici "sempre attivi" che compaiono solo dopo l'accettazione (es. Dynatrace); non scatta se l'elemento è dichiarato anche in una categoria soggetta a consenso |
| `evidenza-asimmetrica` | al primo livello o nelle preferenze "Accetta" e "Rifiuta" hanno forma diversa (pulsante pieno contro link) o superficie molto diversa |
| `dati-personali-a-terzi` | targa, data di nascita, email, codice fiscale o telefono negli indirizzi o nei corpi delle richieste verso terze parti. Certezza alta (gravità alta) se coincidono con i `datiDiProva`; media se trovati per nome del parametro; bassa se somigliano solo per forma. L'invio di un modulo al servizio che lo gestisce (es. HubSpot Forms) è informativo; le email pubblicate dal sito stesso e le PEC non contano |
| `revoca-non-trovata` | nessun link o pulsante per riaprire le preferenze fuori dal banner |
| `link-informativa-assente` | nessun link alla cookie policy nel banner |
| `personalizzazione-non-rispettata` | accettata solo la statistica, ma partono marketing o altre categorie |
| `esito-revoca` | revoca non eseguibile o cookie non tecnici che restano dopo la revoca |
| `attivazione-dopo-revoca` | richieste di tracciamento dopo la revoca del consenso |
| `sottodomini-disomogenei` | sottodomini con CMP diversi o senza banner; cookie policy su altro host; lo stesso sito descritto in due elenchi dichiarati diversi |
| `elementi-non-dichiarati` | elementi osservati assenti dall'elenco dichiarato |
| `dichiarati-non-osservati` | voci dichiarate mai osservate |
| `categoria-incoerente` | es. analytics o heatmap tra i "necessari / sempre attivi"; stesso cookie in più categorie |
| `elementi-non-classificati` | cookie, storage e domini di terze parti che nessuna fonte sa classificare: vengono elencati invece di restare invisibili |
| `endpoint-server-side` | endpoint di raccolta su dominio proprio (`/g/collect`…), con il limite che comporta |

Norme collegate e gravità si cambiano in [`config/norme.yaml`](config/norme.yaml). I riferimenti precaricati vanno **validati dal consulente legale**.

## Elenco dichiarato

In ordine di precedenza:
1. il file indicato in `dichiarati:` per il sito, in CSV o YAML (vedi [`config/dichiarati-esempio.csv`](config/dichiarati-esempio.csv));
2. le API del CMP (`OneTrust.GetDomainData()`, `UC_UI.getServicesBaseInfo()`);
3. le tabelle della cookie policy (`cookiePolicy:` del sito, altrimenti il link del banner o una pagina del campione con "cookie" nell'indirizzo).

Le voci dichiarate ma mai osservate sono riassunte nel report (prime 15) e elencate per intero in `confronto-dichiarati.csv`.

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
- vanilla-cookieconsent il cui script non si carica alla prima visita (ripetizione automatica);
- pagina di verifica anti-bot (Cloudflare);
- applicazione a pagina singola senza sitemap né link (esplorazione con clic);
- analisi del banner, cookie policy con tabelle, scenari personalizza e revoca.

Il tool è stato inoltre validato su 5 siti reali (e-commerce, agenzia, PA, grande distribuzione) con esecuzioni ripetute dall'Italia e dagli USA: banner gestiti e verificati in tutti i casi in cui erano presenti, risultati coincidenti tra esecuzioni.

Chromium viene indirizzato al server locale con `--host-resolver-rules`, quindi non serve la rete.

## Licenze

Software proprietario, © 2026 Filippo Pirini (vedi [`LICENSE`](LICENSE)): nessuna licenza d'uso è concessa a terzi. Le dipendenze e i dati inclusi hanno licenze permissive, compatibili anche con software proprietario e commerciale. Dettagli ed esclusioni sono in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); `npm run licenses` li verifica automaticamente.

## Limiti noti

- Il controllo è campionario.
- Il tracciamento lato server non è osservabile oltre l'endpoint proprio.
- I risultati possono variare con geolocalizzazione, test A/B e aste pubblicitarie.
- Gli elenchi dichiarati letti dalle tabelle della cookie policy possono essere incompleti: se mancano molti elementi, il report lo segnala e la scheda va verificata a vista.
- I siti con protezioni anti-bot possono bloccare il browser automatizzato. Il tool naviga lentamente, dichiara lo user agent e non tenta di aggirare i blocchi.
- Non ancora implementati (in ordine di priorità suggerita):
  - marca temporale qualificata (RFC 3161) sul manifest, per dare data certa alle prove;
  - rilevamento di identificativi senza cookie (fingerprint, ID nei parametri);
  - step di login per le aree riservate;
  - percorsi registrati e ripetibili con dati di prova (oggi i flussi con moduli si fanno con la navigazione manuale);
  - esportazione Excel nativa (i CSV si aprono già in Excel).

Report, HAR e configurazioni dei clienti **non** vanno nel repository (vedi `.gitignore`).
