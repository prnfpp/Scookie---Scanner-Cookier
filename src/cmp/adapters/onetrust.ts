import type { DeclaredItem } from '../../types.js';
import { normalizeDeclaredCategory } from '../../classify/classifier.js';
import { selectorAdapter } from './base.js';

// ID standard dei gruppi OneTrust: C0001 necessari, C0002 prestazioni, C0003 funzionali,
// C0004 targeting, C0005 social. I siti possono definire gruppi propri.
const NON_ESSENTIAL = ['C0002', 'C0003', 'C0004', 'C0005'];

interface OtRawItem {
  name: string;
  host: string;
  kind: 'cookie' | 'servizio';
  group: string;
  status: string;
}

export const onetrust = selectorAdapter({
  id: 'onetrust',
  name: 'OneTrust',
  detectExpr: `window.OneTrust || window.Optanon`,
  detectSelectors: ['#onetrust-banner-sdk', '#onetrust-consent-sdk'],
  bannerSelectors: ['#onetrust-banner-sdk', '#onetrust-pc-sdk'],
  reject: {
    firstLayer: ['#onetrust-reject-all-handler'],
    close: ['#onetrust-banner-sdk .onetrust-close-btn-handler', '#onetrust-banner-sdk .banner-close-button'],
    openPreferences: ['#onetrust-pc-btn-handler'],
    preferencesReject: ['#onetrust-pc-sdk .ot-pc-refuse-all-handler', '#onetrust-pc-sdk .save-preference-btn-handler'],
    api: 'OneTrust.RejectAll()',
  },
  accept: {
    firstLayer: ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler'],
    api: 'OneTrust.AllowAll()',
  },
  stateExpr: `({
    activeGroups: window.OnetrustActiveGroups || window.OptanonActiveGroups || null,
    alertBoxClosed: /OptanonAlertBoxClosed=/.test(document.cookie),
    optanonConsent: (document.cookie.match(/OptanonConsent=([^;]+)/) || [])[1] || null
  })`,
  check(state, choice) {
    const s = state as { activeGroups?: string | null } | null;
    if (!s?.activeGroups) return { consistent: null, detail: 'OnetrustActiveGroups non disponibile' };
    const active = s.activeGroups.split(',').filter(Boolean);
    const on = NON_ESSENTIAL.filter((g) => active.includes(g));
    if (choice === 'rifiuta') {
      return on.length
        ? { consistent: false, detail: `dopo il rifiuto risultano attivi i gruppi ${on.join(', ')} (attivi: ${active.join(', ')})` }
        : { consistent: true, detail: `gruppi attivi: ${active.join(', ')}` };
    }
    return on.length
      ? { consistent: true, detail: `gruppi attivi: ${active.join(', ')}` }
      : { consistent: false, detail: `dopo l'accettazione risultano attivi solo: ${active.join(', ')}` };
  },
  async declared(page) {
    const raw = await page
      .evaluate(() => {
        const w = window as unknown as { OneTrust?: { GetDomainData?: () => unknown } };
        if (!w.OneTrust?.GetDomainData) return null;
        type Ck = { Name?: string; Host?: string };
        type Gr = {
          GroupName?: string;
          Status?: string;
          Cookies?: Ck[];
          FirstPartyCookies?: Ck[];
          Hosts?: { HostName?: string; DisplayName?: string; Cookies?: Ck[] }[];
          SubGroups?: Gr[];
        };
        const data = w.OneTrust.GetDomainData() as { Groups?: Gr[] };
        const out: OtRawItem[] = [];
        const walk = (g: Gr) => {
          const group = g.GroupName ?? '';
          const status = (g.Status ?? '').toLowerCase();
          for (const c of [...(g.Cookies ?? []), ...(g.FirstPartyCookies ?? [])]) {
            if (c.Name) out.push({ name: c.Name, host: c.Host ?? '', kind: 'cookie', group, status });
          }
          for (const h of g.Hosts ?? []) {
            const cookies = h.Cookies ?? [];
            if (!cookies.length && h.HostName) out.push({ name: h.DisplayName || h.HostName, host: h.HostName, kind: 'servizio', group, status });
            for (const c of cookies) if (c.Name) out.push({ name: c.Name, host: c.Host || h.HostName || '', kind: 'cookie', group, status });
          }
          for (const sg of g.SubGroups ?? []) walk(sg);
        };
        for (const g of data.Groups ?? []) walk(g);
        return out;
      })
      .catch(() => null);
    if (!raw) return null;
    return (raw as OtRawItem[]).map(
      (r): DeclaredItem => ({
        kind: r.kind,
        name: r.name,
        domain: r.host || undefined,
        declaredCategory: r.group,
        category: normalizeDeclaredCategory(r.group),
        alwaysActive: r.status.includes('always'),
        source: 'cmp:onetrust (GetDomainData)',
      }),
    );
  },
});
