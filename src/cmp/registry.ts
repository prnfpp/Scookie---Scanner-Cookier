import { onetrust } from './adapters/onetrust.js';
import { complianz } from './adapters/complianz.js';
import { cookiebot } from './adapters/cookiebot.js';
import { cookieyes } from './adapters/cookieyes.js';
import { didomi } from './adapters/didomi.js';
import { hubspot } from './adapters/hubspot.js';
import { iubenda } from './adapters/iubenda.js';
import { tcf } from './adapters/tcf.js';
import { usercentrics } from './adapters/usercentrics.js';
import type { CmpAdapter } from './types.js';

/**
 * Adattatori in ordine di tentativo. Per aggiungere un CMP: creare il modulo in ./adapters
 * e inserirlo qui. TCF va per ultimo: legge lo stato ma non interagisce.
 */
export const ADAPTERS: CmpAdapter[] = [onetrust, cookiebot, iubenda, didomi, usercentrics, cookieyes, complianz, hubspot, tcf];
