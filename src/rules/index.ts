import { attivazioneDopoRifiuto } from './regole/attivazione-dopo-rifiuto.js';
import { accessoBloccato, bannerAssente, bannerIntermittente, sottodominiDisomogenei } from './regole/banner-e-sottodomini.js';
import { categoriaIncoerente, dichiaratiNonOsservati, nonDichiarati, tecnicoDopoConsenso } from './regole/confronto-dichiarati.js';
import { consentModeSenzaConsenso } from './regole/consent-mode-senza-consenso.js';
import { cookiePrimaDelConsenso } from './regole/cookie-prima-del-consenso.js';
import { rifiutoNonAlPrimoLivello, sceltaNonVerificata } from './regole/interazione-banner.js';
import { richiestaTrackerPrimaDelConsenso } from './regole/richiesta-tracker-prima-del-consenso.js';
import { elementiNonClassificati } from './regole/elementi-non-classificati.js';
import { datiPersonaliATerzi } from './regole/dati-personali.js';
import { attivazioneDopoRevoca, esitoRevoca, personalizzazioneNonRispettata } from './regole/scenari-aggiuntivi.js';
import { endpointServerSide } from './regole/server-side.js';
import { categorieNonPresentate, categoriePreattivate, evidenzaAsimmetrica, linkInformativaAssente, revocaNonTrovata, strutturaBanner } from './regole/struttura-banner.js';
import type { Rule } from './types.js';

/** Regole attive. Per aggiungerne una: creare il modulo in ./regole e inserirlo qui. */
export const RULES: Rule[] = [
  datiPersonaliATerzi,
  cookiePrimaDelConsenso,
  richiestaTrackerPrimaDelConsenso,
  consentModeSenzaConsenso,
  attivazioneDopoRifiuto,
  attivazioneDopoRevoca,
  personalizzazioneNonRispettata,
  esitoRevoca,
  rifiutoNonAlPrimoLivello,
  categoriePreattivate,
  revocaNonTrovata,
  linkInformativaAssente,
  strutturaBanner,
  evidenzaAsimmetrica,
  categorieNonPresentate,
  sceltaNonVerificata,
  accessoBloccato,
  bannerAssente,
  bannerIntermittente,
  sottodominiDisomogenei,
  nonDichiarati,
  categoriaIncoerente,
  tecnicoDopoConsenso,
  dichiaratiNonOsservati,
  elementiNonClassificati,
  endpointServerSide,
];
