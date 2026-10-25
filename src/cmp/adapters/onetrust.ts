import type { DeclaredItem } from '../../types.js';
import { normalizeDeclaredCategory } from '../../classify/classifier.js';
import { selectorAdapter } from './base.js';

// ID standard dei gruppi OneTrust: C0001 necessari, C0002 prestazioni, C0003 funzionali,
// C0004 targeting, C0005 social. I siti possono definire gruppi propri.
const NON_ESSENTIAL = ['C0002', 'C0003', 'C0004', 'C0005'];

interface OtGroup {
  id: string;
  nome: string;
  stato: string;
  elementi: number;
  /** Il gruppo ha un interruttore nel centro preferenze (null se il centro preferenze non è nella pagina). */
  inPc?: boolean | null;
}

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
  // Lo stato include i gruppi configurati (GetDomainData): i siti possono usare ID propri al posto di C000x.
  stateExpr: `(() => {
    let gruppi = null;
    try {
      const d = window.OneTrust && OneTrust.GetDomainData ? OneTrust.GetDomainData() : null;
      if (d && Array.isArray(d.Groups)) {
        gruppi = [];
        const pc = document.getElementById('onetrust-pc-sdk');
        const walk = (g) => {
          const n = (g.Cookies || []).length + (g.FirstPartyCookies || []).length + (g.Hosts || []).length;
          const id = String(g.OptanonGroupId ?? g.CustomGroupId ?? '');
          const inPc = pc ? !!pc.querySelector('[id="ot-group-id-' + id + '"], [data-optanongroupid="' + id + '"]') : null;
          gruppi.push({ id, nome: g.GroupName || '', stato: String(g.Status || '').toLowerCase(), elementi: n, inPc });
          (g.SubGroups || []).forEach(walk);
        };
        d.Groups.forEach(walk);
      }
    } catch (e) {}
    return {
      activeGroups: window.OnetrustActiveGroups || window.OptanonActiveGroups || null,
      gruppi,
      alertBoxClosed: /OptanonAlertBoxClosed=/.test(document.cookie),
      optanonConsent: (document.cookie.match(/OptanonConsent=([^;]+)/) || [])[1] || null,
    };
  })()`,
  check(state, choice) {
    const s = state as { activeGroups?: string | null; gruppi?: OtGroup[] | null } | null;
    if (!s?.activeGroups) return { consistent: null, detail: 'OnetrustActiveGroups non disponibile' };
    const active = s.activeGroups.split(',').filter(Boolean);
    const groups = (s.gruppi ?? []).filter((g) => g.id);
    const label = (id: string) => {
      const g = groups.find((x) => x.id === id);
      return g?.nome ? `${id} "${g.nome}"` : id;
    };
    if (!groups.length) {
      // Senza configurazione leggibile si confrontano solo gli ID standard; con ID propri il risultato non è determinabile.
      const standard = active.every((g) => /^C\d{4}$/.test(g));
      const on = NON_ESSENTIAL.filter((g) => active.includes(g));
      if (choice === 'rifiuta') {
        return on.length
          ? { consistent: false, detail: `dopo il rifiuto risultano attivi i gruppi ${on.join(', ')} (attivi: ${active.join(', ')})` }
          : { consistent: standard ? true : null, detail: `gruppi attivi: ${active.join(', ')}` };
      }
      if (!standard) return { consistent: null, detail: `gruppi attivi: ${active.join(', ')}; configurazione dei gruppi non leggibile` };
      return on.length
        ? { consistent: true, detail: `gruppi attivi: ${active.join(', ')}` }
        : { consistent: false, detail: `dopo l'accettazione risultano attivi solo: ${active.join(', ')}` };
    }
    // Gruppi non essenziali = configurati, non "sempre attivi" e con almeno un cookie o fornitore associato.
    const nonEssential = groups.filter((g) => !g.stato.includes('always') && g.id !== 'C0001' && g.elementi > 0).map((g) => g.id);
    const on = nonEssential.filter((g) => active.includes(g));
    const summary = `gruppi configurati: ${groups.map((g) => `${label(g.id)}${g.stato.includes('always') ? ' (sempre attivo)' : ''}`).join(', ')}; attivi: ${active.map(label).join(', ') || 'nessuno'}`;
    if (choice === 'rifiuta') {
      return on.length
        ? { consistent: false, detail: `dopo il rifiuto risultano attivi gruppi non essenziali: ${on.map(label).join(', ')} (${summary})` }
        : { consistent: true, detail: summary };
    }
    const missing = nonEssential.filter((g) => !active.includes(g));
    if (!nonEssential.length) return { consistent: null, detail: `nessun gruppo non essenziale configurato (${summary})` };
    // Gruppi che l'utente non vede nel centro preferenze: "Accetta" può non riguardarli (es. configurazione per paese).
    const hidden = missing.filter((id) => groups.find((g) => g.id === id)?.inPc === false);
    const shown = missing.filter((id) => !hidden.includes(id));
    if (shown.length) return { consistent: false, detail: `dopo l'accettazione non risultano attivi: ${shown.map(label).join(', ')} (${summary})` };
    if (hidden.length) {
      return {
        consistent: null,
        detail: `dopo l'accettazione non risultano attivi ${hidden.map(label).join(', ')}, che però non compaiono nel centro preferenze (l'utente non può sceglierli): coerenza non determinabile (${summary})`,
      };
    }
    return { consistent: true, detail: summary };
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
