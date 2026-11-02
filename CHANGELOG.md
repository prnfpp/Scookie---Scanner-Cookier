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
