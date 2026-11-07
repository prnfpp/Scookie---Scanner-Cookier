# Changelog

## Non rilasciato

Correzioni dopo la verifica manuale di una rilevazione su un sito WordPress senza banner con un lettore Spotify
incorporato e Matomo senza cookie. Ogni voce vale per qualsiasi sito.

- **Un fatto, un rilievo.** Le richieste di raccolta di un fornitore che ha già scritto cookie o storage non tecnici
  prima della scelta non producono più un rilievo `richiesta-tracker-prima-del-consenso` separato anche quando sono di
  terza parte (prima valeva solo per l'endpoint sul dominio del sito): sono riportate nel rilievo
  `cookie-prima-del-consenso` come dati inviati, con il momento (al caricamento / dopo lo scroll), la natura delle
  richieste e il contenuto incorporato da cui partono. Nella sintesi, `banner-assente` si aggiunge al punto sui
  tracciamenti "senza alcun meccanismo di consenso" dello stesso sito invece di formare un punto a sé.
- **Categorie per elemento.** Se gli elementi di un rilievo hanno categorie diverse (es. `sp_t` marketing,
  `sp_landing` statistica, `sentryReplaySession` registrazione sessioni) il testo le elenca una per una invece di
  usare la categoria del primo.
- **Sentry.** Il collettore legge i tipi degli elementi dell'envelope (`envelopeItems`): con `replay_event` o
  `replay_recording` la richiesta è classificata come registrazione della sessione (Session Replay), non come
  statistica. La nota delle voci Sentry in `data/trackers.yaml` precisa che il monitoraggio degli errori non è una
  statistica di navigazione. Vale per le nuove raccolte (il corpo non è conservato nelle rilevazioni precedenti).
- **Matomo di prima parte senza cookie: priorità predefinita bassa.** `regole.richiesta-tracker-prima-del-consenso.primaParteSenzaCookie.gravita`
  in `config/norme.yaml` passa da `alta` a `bassa`: con IP mascherato e senza incroci le Linee guida del Garante
  assimilano questi analytics ai cookie tecnici. Il rilievo resta, con le condizioni non verificabili dal browser.
- **"Nessun banner" con il solo Matomo senza cookie.** `banner-assente` non sale più a priorità media "pur in presenza
  di tracciamenti" quando le sole raccolte non tecniche sono di Matomo di prima parte senza cookie e senza dati
  dell'utente negli hit: resta informativo e rimanda al rilievo dedicato. Contano anche gli archivi locali (storage)
  non tecnici, non solo i cookie.
- **Totali con la media per sessione.** Accanto ai conteggi delle richieste (es. "560 richieste di raccolta") il testo
  indica in quante sessioni e la media per sessione.
- **Nuova regola `ip-a-terze-parti`** (informativa, art. 6 e 13 GDPR, da validare): Google Fonts e Gravatar caricati
  direttamente dalle pagine del sito, che ricevono IP e pagina del visitatore a ogni caricamento. Le risorse dei
  contenuti incorporati non contano.

## 0.1.2 — 2026-11-04

Correzioni dopo la verifica manuale di due rilevazioni su siti WordPress senza banner, con Matomo ospitato sul sito.
Ogni voce vale per qualsiasi sito; i fatti restano rilievi, cambia come sono descritti, classificati e ordinati.

- **Fix 1 — testi coerenti quando il banner non c'è.** Se in nessuna sessione valida del sito compare un banner o un
  gestore del consenso, rilievi e sintesi dicono "senza alcun meccanismo di consenso (nessun banner rilevato)" invece
  di "prima di qualsiasi scelta sul banner" (il momento "al caricamento / dopo lo scroll" resta). La riga "Scenari"
  elenca solo gli scenari eseguiti; quelli con scelta in cui il banner non c'era sono indicati come "non eseguiti
  (nessun banner)" e non contano nella ripetibilità ("k su N"). Il titolo del rilievo sulle richieste dipende dalla
  parte: "Richieste di tracciamento di prima parte…", "…di prima e terza parte…", "Richieste a terze parti…", con
  "in assenza di banner" al posto di "prima della scelta"; la tabella "Rilievi per tipo" usa lo stesso titolo. Le
  colonne dell'inventario "Prima della scelta" diventano "Senza banner".
- **Fix 2 — "non applicabile" al posto di 0.** Nell'inventario la colonna "Dopo rifiuto" distingue tre casi: un
  numero (o "sì", "rinnovato", "ancora presente") se l'elemento è stato osservato; 0 (o "no") se il rifiuto è stato
  eseguito e l'elemento non è comparso; "n/a" se il rifiuto non è stato eseguito (nessun banner, comando non trovato,
  sessioni non valide). Una nota sotto ogni tabella lo spiega. Nei CSV nessuna cella vuota per questi casi:
  `cookie.csv` e `richieste.csv` hanno la colonna `esito_scelta` (`eseguita`, `non-applicabile (nessun banner)`,
  `non-applicabile (nessuna-azione)`, `non-applicabile (scelta non eseguita: …)`), `ms_dalla_scelta` vale
  `non-applicabile` senza scelta, e `confronto-dichiarati.csv` ha `osservato_dopo_rifiuto` (`sì`, `no`,
  `non-applicabile`) e valori espliciti per categoria osservata, differenza di categoria e scenari.
- **Fix 3 — momento calcolato per pagina, raccolte separate dagli script.** Lo stadio "dopo lo scroll" restava attivo
  anche sulle pagine successive della sessione: negli scenari con scelta senza banner (e in ogni percorso di più
  pagine prima della scelta) tutte le richieste dopo la prima pagina finivano "dopo lo scroll", compreso il pageview
  che parte al caricamento. Ora "al caricamento" vuol dire prima della prima interazione simulata (mouse o rotella)
  *su quella pagina* e lo stadio torna "al caricamento" a ogni nuova pagina; gli invii all'uscita tengono il momento
  della pagina che si lascia; il primo movimento del mouse, che porta il cursore sopra la pagina, non conta come
  interazione. Le sessioni registrano le visite (`visits`: pagina, inizio, prima interazione) e ogni richiesta la sua
  visita (`visit`). I testi non sommano più raccolte e script: "N richieste di raccolta dati (al caricamento: X,
  dopo lo scroll: Y); M download di script o risorse (…)". Nuovo controllo di coerenza nelle anomalie: per uno
  strumento di pageview (statistica di prima parte, Matomo/Piwik) le raccolte "al caricamento" non possono superare
  le pagine visitate. Nuovo `scripts/conta-richieste.mjs` per contare, pagina per pagina, le richieste di una
  rilevazione e il momento assegnato, dai dati e dal HAR. Il momento si ricalcola solo con una nuova raccolta: in
  `rigenera` restano i momenti registrati.
- **Fix 4 — niente scenari con scelta se non c'è nessun CMP.** Le sessioni "nessuna azione" di un sito si eseguono
  per prime; se in nessuna di quelle valide (né nelle navigazioni manuali) compare un banner o un gestore del consenso,
  anche solo riconosciuto dall'euristica, gli scenari rifiuta, accetta, personalizza, revoca e chiudi non si eseguono
  per quel sito. Con una sola sessione "nessuna azione" se ne fa prima una di conferma (se il banner compare, la prima
  è sostituita come nelle altre ripetizioni). Se il banner si vede anche una sola volta, si eseguono tutti gli scenari
  come prima (regola `banner-intermittente`). Nei Limiti una sola riga: "scenari con scelta non eseguiti: nessun
  banner rilevato in N sessioni"; il perimetro lo indica accanto agli scenari. Anche nelle rilevazioni precedenti
  rigenerate, per i siti senza banner, i Limiti hanno una riga sola invece di una per scenario. Opzione
  `scenari.saltaSenzaBanner` (predefinita `true`) nello schema, in `config/esempio.yaml` e nell'interfaccia (Opzioni
  → avanzate); l'avanzamento toglie dal totale le sessioni saltate e la stima della durata indica quanto dura un
  audit di siti senza banner. Su un sito senza banner l'audit passa da circa 6 × 3 sessioni a quelle "nessuna azione".
- **Fix 5 — Spotify, Sentry, Gravatar e risorse dei temi classificati.** In `data/trackers.yaml`: lettore Spotify
  incorporato (`open.spotify.com/embed…`, `embed-cdn.spotifycdn.com`, `image-cdn-*.spotifycdn.com`, `encore.scdn.co`,
  `apresolve.spotify.com`, servizi `*-spclient.spotify.com`) come "Spotify (contenuto incorporato)"; la telemetria del
  lettore (`*-spclient.spotify.com` con percorsi `/gabo-receiver-service/`, `/melody/`, `/event-service/`) come
  statistica; Sentry (`ingest.sentry.io`, `ingest.us.sentry.io`, `ingest.de.sentry.io`) come monitoraggio di errori e
  prestazioni; Gravatar (Automattic) con la nota sull'hash dell'email dell'autore; `themes.muffingroup.com` come risorsa
  del tema servita dal server dello sviluppatore. I domini delle voci accettano un modello con `*`. In
  `data/cookies.yaml`: `sp_t` (identificativo del dispositivo e del visitatore, circa 1 anno) come marketing,
  `sp_landing` come statistica da valutare, `sentryReplaySession` come registrazione delle sessioni; l'elenco curato
  prevale su Open Cookie Database e la fonte si legge "elenco curato Scookie". Nuova opzione `raggruppa` delle voci:
  tutto ciò che parte dal documento di un contenuto incorporato (richieste, anche verso altri fornitori, e storage) è
  riunito sotto di lui, con "Sentry, caricato da Spotify (contenuto incorporato)" nella natura delle richieste e
  nell'inventario, come per il widget di Google Calendar. Così un lettore che, senza banner o prima della scelta,
  scrive un identificativo o invia telemetria e Session Replay produce i rilievi `cookie-prima-del-consenso` e
  `richiesta-tracker-prima-del-consenso` con la stessa priorità di un video YouTube non bloccato, non
  `elementi-non-classificati`. Le classificazioni si riapplicano con `rigenera`.
- **Fix 6 — Matomo senza cookie.** Per Matomo/Piwik ospitato sul sito lo stato dei cookie si determina dai fatti:
  "senza cookie" se nessun cookie `_pk_*` o `MATOMO_SESSID` è scritto, il parametro `_id` degli hit è vuoto o assente
  e, come prova accessoria, la pagina ha `disableCookies` nella configurazione `_paq` oppure il tracker risponde
  `hasCookies() === false` a fine pagina (lettura nuova, `statsProbe`; nelle rilevazioni precedenti i comandi `_paq` si
  leggono, se possibile, dalle pagine salvate nel HAR); "con cookie" se sono scritti `_pk_id`/`_pk_ses`; altrimenti
  "non determinabile". Nessuna qualificazione ("tecnico", "esente"): il rilievo dice "Matomo di prima parte, in
  modalità senza cookie", la forza della prova resta "dati di navigazione inviati", i dettagli elencano i fatti e gli
  eventuali parametri con dati dell'utente (`uid`, `_cvar`, `dimensionN` con valore), e il nuovo campo "Condizioni
  rilevanti non verificabili dal browser" elenca mascheramento dell'IP, conservazione, incroci con altre fonti e
  titolarità del server. La priorità non cambia da sola: nuova chiave
  `regole.richiesta-tracker-prima-del-consenso.primaParteSenzaCookie.gravita` in `config/norme.yaml`, con lo stesso
  valore della regola, da decidere a cura del legale. Inventario: colonna "Cookie" nella tabella degli strumenti sul
  dominio del sito; sintesi: "Matomo di prima parte, senza cookie"; `dati.json`: `statoCookie` per sito.
- **Fix 7 — informative scritte come testo e informativa assente.** Se l'elenco non viene dal gestore o da un file,
  la cookie policy si cerca nell'ordine: indirizzo in configurazione, link nel banner, pagina "cookie" scoperta, link
  nella pagina iniziale (piè di pagina, menu) con "cookie", "privacy", "informativa" o "note legali" nel testo o
  nell'indirizzo e link `rel="privacy-policy"`, percorsi comuni (`/privacy-policy/`, `/cookie-policy/`, `/privacy/`,
  `/informativa-privacy/`, `/informativa-cookie/`, `/cookie/`), URL della sitemap con quelle parole. Vale solo una
  risposta 200 sullo stesso sito, con lo stato reale letto dal browser (una pagina d'errore con il piè di pagina non
  conta). Il rapporto dice quale pagina è stata usata e come è stata trovata, e conserva tutti i tentativi con lo
  stato e lo screenshot del piè di pagina. Senza tabelle leggibili si estrae una dichiarazione testuale: sezione sui
  cookie, fornitori noti nominati (dall'elenco dei domini e alias come Google Analytics, YouTube, Facebook), affermazioni
  tipiche ("solo cookie tecnici", "nessun cookie di profilazione", "nessun cookie per il tracciamento", "cookie di
  terze parti"), ciascuno con una citazione di al massimo ~200 caratteri. Il riquadro "Elenco dichiarato" mostra
  "testuale (N fornitori citati)"; la sezione 4 ha il confronto testuale per fornitore ("osservato e citato",
  "osservato, non citato", "citato, non osservato") e, per le affermazioni, i cookie e gli storage non tecnici
  osservati; nuovo `confronto-testuale.csv`. Nuova regola `informativa-assente` (priorità media, art. 13 GDPR e Linee
  guida cookie del Garante 2021, da validare): nessuna pagina di informativa raggiungibile e nessun banner, con i
  percorsi provati, il loro stato e il piè di pagina come prove. `link-informativa-assente` resta per il banner senza
  link. Ricerca e lettura richiedono una nuova raccolta: con `rigenera` non si fanno.

- **Sessioni bloccate da iframe non caricati.** Un iframe con `loading="lazy"` sotto la piega (es. un player Spotify
  o YouTube incorporato) resta senza documento finché non entra in vista: le letture su di lui (storage, scansione del
  banner, `count`/`isVisible`) restavano in attesa per sempre, e ogni sessione si fermava al tetto di 5 minuti con
  dati parziali (cookie e storage non letti). Questi frame ora si saltano, e ogni lettura di un frame ha un tempo
  massimo. Su un sito con un iframe così una sessione passa da circa 5 minuti a circa 30 secondi. Quando una sessione
  viene interrotta dal tetto di durata, il registro lo dice subito ("ATTENZIONE: sessione interrotta…").
- **Pulsante "Interrompi l'audit".** Nella scheda Audit in corso, con conferma: chiude subito il browser (ogni attesa
  in corso termina) e ferma l'audit entro pochi secondi, in qualsiasi fase prima del rapporto. La cartella resta con un
  file `INTERROTTO.txt` e senza rapporto, perché i dati sono parziali. Se qualcosa non risponde neppure alla chiusura
  del browser, dopo 30 secondi l'audit si considera fermo comunque, così si può avviarne un altro o chiudere Scookie.
  Le attese del ripristino della connessione si fermano anch'esse. Nuovo comando `POST /api/interrompi`.

## 0.1.1 — 2026-11-02

Correzioni dopo la verifica manuale di una rilevazione su un sito con Complianz. Ogni voce vale per qualsiasi sito
con lo stesso gestore o, dove indicato, per qualsiasi gestore.

- **Visibilità reale del banner (R-004, R-005, R-011).** Una sola funzione decide se il banner è visibile, prima e
  dopo la scelta e alla pagina successiva. Ha la precedenza lo stato del gestore (`isBannerVisible`; per Complianz:
  classe `cmplz-show` senza `cmplz-dismissed`/`cmplz-hidden`); il ripiego generico richiede un elemento con area,
  almeno in parte nella finestra, non trasparente e senza antenati nascosti o `aria-hidden`. Il riconoscimento
  generico si usa solo se nessun gestore ha deciso. I rilievi riportano l'esito reale ("banner chiuso" / "banner
  ancora visibile"); il controllo "il banner ricompare" vale per tutti gli scenari con scelta; `sessioni.csv` ha le
  colonne `banner_visibile_dopo_scelta` e `banner_alla_pagina_successiva`.
- **Perimetro dell'analisi del banner (R-006, R-007, R-013).** Comandi, interruttori, categorie e misure si leggono
  solo dentro il contenitore del gestore (elenco in `src/cmp/containers.ts`) e negli iframe del gestore (indirizzo di
  un CMP noto o iframe sovrapposto alla pagina). Gli iframe di contenuti incorporati in linea (calendari, video, mappe)
  non sono più trattati come banner. Celle di griglia, opzioni e schede non sono interruttori di categoria. Complianz
  legge le categorie da `input[data-category]` del banner; la categoria con "Sempre attivo" (`.cmplz-always-active`)
  è attiva e non modificabile anche se l'input non ha l'attributo `disabled`. Oltre 12 "categorie" l'analisi è dichiarata non affidabile
  nei Limiti e il rilievo `categorie-preattivate` non si produce. La X si riconosce anche dall'etichetta "Chiudi la
  finestra di dialogo" e dai selettori di chiusura dell'adattatore; se lo scenario "chiudi" ha usato la X, la struttura
  del banner non può dire "X assente".
- **Scenario "personalizza" con Complianz (R-006).** Nuovo personalizzatore: "Visualizza le preferenze", attiva solo
  `cmplz_statistics`, disattiva marketing e preferenze, "Salva preferenze"; verifica dai cookie `cmplz_*` (atteso
  `cmplz_statistics=allow`, le altre `deny` o assenti). Per qualsiasi gestore, se la scelta non risulta verificata il
  rilievo `personalizzazione-non-rispettata` esce con priorità abbassata e lo dichiara nel testo. Un fornitore attivo
  anche dopo il rifiuto è accorpato ("stesso comportamento del rifiuto, vedi R-xxx", priorità bassa), come già per la
  revoca. I rimandi "vedi R-xxx" tra rilievi si risolvono dopo la numerazione.
- **Comando di revoca trovato anche dopo la scelta (R-010, coerenza con R-009/R-012/R-013).** Il comando per rivedere
  la scelta si cerca anche alla prima pagina dopo la scelta in tutti gli scenari con scelta (`revokeAfterChoice`),
  nella pagina e negli iframe del gestore. Complianz: `.cmplz-manage-consent` e varianti `manage-consent-*`. Se il
  comando è stato trovato dopo la scelta, o lo scenario "revoca" ha riaperto le preferenze con un comando della pagina
  (non via API), `revoca-non-trovata` non scatta e la struttura del banner dice "trovato", quale comando e se è
  visibile solo dopo la scelta.
- **Tracciamento di prima parte dopo il rifiuto e dopo la X (falso negativo Matomo).** Il classificatore riconosce gli
  endpoint di raccolta anche per percorso e parametri su qualsiasi host (`dominio: "*"` con `percorsi`/`parametri` in
  `data/trackers.yaml`): Matomo/Piwik `matomo.php`, `piwik.php`, `matomo.js`, e hit con `idsite=` e `rec=1`, anche via
  `sendBeacon`/`fetch keepalive`. I cookie `_pk_*` sono attribuiti a Matomo (`data/cookies.yaml`). Il raccoglitore
  registra se un cookie presente prima della scelta c'è ancora dopo (`presentAfterChoice`) e se è stato riscritto
  (valore o scadenza cambiati: `renewals`, anche dopo la revoca). Le regole dopo il rifiuto, la X e la revoca contano
  i cookie riscritti come attività; i cookie soltanto rimasti sono un fatto distinto di priorità bassa. Prima della
  scelta gli hit di prima parte dello stesso fornitore dei cookie sono accorpati nel rilievo sui cookie, la cui forza
  della prova dichiara anche i dati inviati. Inventario: colonna "Dopo rifiuto" con "sì", "rinnovato" o "ancora
  presente" e tabella delle raccolte sul dominio del sito. Le classificazioni si riapplicano con `rigenera`; i dati
  sui cookie riscritti esistono solo nelle rilevazioni fatte con la 0.1.1.
- **Attribuzione delle richieste alla pagina giusta (R-004, R-005, R-009).** La pagina di una richiesta è il documento
  principale che ospita il frame che l'ha generata, letto al momento della richiesta (`request.frame()`), non l'URL
  verso cui si sta navigando. Le richieste partite da un documento che si sta lasciando (tra l'inizio della navigazione
  e il commit della nuova pagina, o da un frame già staccato) sono marcate `sentOnExit` ("inviata all'uscita"):
  restano attribuite alla pagina che ospita il contenuto e i rilievi le elencano a parte ("Invii all'uscita dalla
  pagina"). `richieste.csv` ha la colonna `inviata_all_uscita`. Per le rilevazioni già raccolte, `rigenera` ricostruisce
  il frame di origine dal campo `_frameref` del file HAR e riattribuisce le richieste degli iframe partite all'uscita
  dalla pagina che li ospitava (quelle del frame principale restano come registrate).
- **Domini non classificati (R-008).** `data/trackers.yaml`: accessiBe (`acsbapp.com`, `acswapp.com`) come widget di
  accessibilità di terza parte, categoria funzionalità, con nota "da valutare se raccoglie dati"; Google Calendar
  appuntamenti (`calendar.google.com` solo per `/calendar/appointments/`, `calendar-pa.clients6.google.com`) come
  contenuto incorporato di Google. Dopo la verifica sui HAR (frame di origine e contenuto): `jnn-pa.googleapis.com`,
  `yt3.ggpht.com` (lettore YouTube) e `lh3.googleusercontent.com` funzionalità; `www.google.com/js/th/` e
  `csp.withgoogle.com` tecnici; `play.google.com/log` (telemetria dei contenuti incorporati) statistica. Le
  classificazioni si riapplicano con `rigenera`.
- **Testi del rapporto.** Nuova `src/util/text.ts` (`plural`, `nWords`, `labelled`) usata nei template e nelle regole
  con numeri: niente più "1 categoria risulta già attive", "attiva e modificabili", "1 sessioni non hanno potuto…",
  "1 sessioni su 3", "1 chiavi", "1 voci", "1 rilievi" ecc. La sintesi non lascia elenchi vuoti dopo i due punti:
  il rilievo `personalizzazione-non-rispettata` ora indica il fornitore e, se l'elenco resta vuoto, il punto usa un
  testo alternativo. Test di regola aggiunti in `test/correzioni-0.1.1.test.ts` per i casi generali dei fix 2–5.
- **Accorpamento dei fornitori nei rilievi dopo la scelta.** Cookie e richieste dello stesso contenuto incorporato con
  nomi diversi nelle fonti (cookie "Youtube" di Open Cookie Database, richieste "Google" dell'elenco dei domini) sono
  un solo fornitore nei rilievi dopo il rifiuto, la X, la revoca e la personalizzazione e nella sintesi. Le categorie
  diverse dello stesso fornitore restano schede distinte.
- **Seconda verifica del rapporto.**
  - Contenuti incorporati: ogni richiesta registra il documento dell'iframe che l'ha inviata (`frameUrl`; per le
    rilevazioni precedenti `rigenera` lo ricostruisce dal HAR). Se l'iframe è un contenuto riconosciuto dello stesso
    fornitore, la richiesta è attribuita a quel contenuto (es. il log di `play.google.com` inviato dal widget di Google
    Calendar è di "Google Calendar (contenuti incorporati)", non un terzo tracker di Google); i rilievi lo indicano.
  - Raccolte e script contati a parte nei rilievi ("8 richieste (4 di raccolta dati, 4 di script o risorse)") e
    nella tabella degli strumenti sul dominio del sito, con la colonna "Tipo".
  - Dopo la revoca la forza della prova dichiara anche i dati inviati, come dopo il rifiuto.
  - Cookie rimasti dopo la revoca: "presenti prima della revoca", con quanti erano già scritti prima di qualsiasi scelta.
  - Testi: non si toglie più lo spazio davanti ai nomi che iniziano con il punto (".youtube.com",
    ".cmplz-manage-consent"); elementi non classificati senza voci a zero; titolo della sintesi con le sole categorie
    osservate.
