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
