# Changelog

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
  legge le categorie da `input[data-category]` del banner. Oltre 12 "categorie" l'analisi è dichiarata non affidabile
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
  contenuto incorporato di Google. Le classificazioni si riapplicano con `rigenera`. Gli altri domini Google del
  rilievo restano non classificati in attesa della verifica sui HAR (proposta nel messaggio del commit).
- **Testi del rapporto.** Nuova `src/util/text.ts` (`plural`, `nWords`, `labelled`) usata nei template e nelle regole
  con numeri: niente più "1 categoria risulta già attive", "attiva e modificabili", "1 sessioni non hanno potuto…",
  "1 sessioni su 3", "1 chiavi", "1 voci", "1 rilievi" ecc. La sintesi non lascia elenchi vuoti dopo i due punti:
  il rilievo `personalizzazione-non-rispettata` ora indica il fornitore e, se l'elenco resta vuoto, il punto usa un
  testo alternativo. Test di regola aggiunti in `test/correzioni-0.1.1.test.ts` per i casi generali dei fix 2–5.
