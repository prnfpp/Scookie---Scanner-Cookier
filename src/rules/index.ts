import { attivazioneDopoRifiuto } from './regole/attivazione-dopo-rifiuto.js';
import { bannerAssente, sottodominiDisomogenei } from './regole/banner-e-sottodomini.js';
import { categoriaIncoerente, dichiaratiNonOsservati, nonDichiarati } from './regole/confronto-dichiarati.js';
import { consentModeSenzaConsenso } from './regole/consent-mode-senza-consenso.js';
import { cookiePrimaDelConsenso } from './regole/cookie-prima-del-consenso.js';
import { rifiutoNonAlPrimoLivello, sceltaNonVerificata } from './regole/interazione-banner.js';
import { richiestaTrackerPrimaDelConsenso } from './regole/richiesta-tracker-prima-del-consenso.js';
import { elementiNonClassificati } from './regole/elementi-non-classificati.js';
import { endpointServerSide } from './regole/server-side.js';
import type { Rule } from './types.js';

/** Regole attive. Per aggiungerne una: creare il modulo in ./regole e inserirlo qui. */
export const RULES: Rule[] = [
  cookiePrimaDelConsenso,
  richiestaTrackerPrimaDelConsenso,
  consentModeSenzaConsenso,
  attivazioneDopoRifiuto,
  rifiutoNonAlPrimoLivello,
  sceltaNonVerificata,
  bannerAssente,
  sottodominiDisomogenei,
  nonDichiarati,
  categoriaIncoerente,
  dichiaratiNonOsservati,
  elementiNonClassificati,
  endpointServerSide,
];
