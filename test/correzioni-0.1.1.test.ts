import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Classifier } from '../src/classify/classifier.js';

// Correzioni della versione 0.1.1: casi generali, senza riferimenti a siti reali.

test('fix 5: strumenti di statistica ospitati sul sito riconosciuti da percorso e parametri, su qualsiasi host', () => {
  const c = new Classifier();
  assert.equal(c.classifyHost('www.esempio.it', '/wp-content/plugins/matomo/app/matomo.php', '?idsite=1&rec=1')?.azienda, 'Matomo');
  assert.equal(c.classifyHost('stats.esempio.it', '/piwik.php')?.categoria, 'statistica');
  assert.equal(c.classifyHost('www.esempio.it', '/wp-content/uploads/matomo/matomo.js')?.azienda, 'Matomo');
  assert.equal(c.classifyHost('www.esempio.it', '/js/', '?idsite=3&rec=1&url=x')?.azienda, 'Matomo');
  // servono entrambi i parametri; un percorso qualsiasi non basta
  assert.equal(c.classifyHost('www.esempio.it', '/js/', '?idsite=3'), undefined);
  assert.equal(c.classifyHost('www.esempio.it', '/pagina'), undefined);
  // il dominio specifico prevale sulla voce generica
  assert.equal(c.classifyHost('www.google-analytics.com', '/matomo.php')?.azienda, 'Google');
  const pk = c.classifyName('_pk_id.1.ab12', 'www.esempio.it');
  assert.equal(pk.category, 'statistica');
  assert.equal(pk.platform, 'Matomo');
  assert.throws(() => new Classifier([{ dominio: '*', azienda: 'X', categoria: 'statistica' }]), /senza percorsi né parametri/);
});

test('fix 7: widget di accessibilità e prenotazione appuntamenti di Google classificati', () => {
  const c = new Classifier();
  for (const h of ['eu.acsbapp.com', 'eu-cdn.acsbapp.com', 'embeds.acswapp.com']) {
    const t = c.classifyHost(h, '/x.js')!;
    assert.equal(t.azienda, 'accessiBe', h);
    assert.equal(t.categoria, 'funzionalita', h);
    assert.match(t.nota ?? '', /da valutare se raccoglie dati/);
  }
  assert.equal(c.classifyHost('calendar.google.com', '/calendar/appointments/schedules/AbC')?.azienda, 'Google Calendar (contenuti incorporati)');
  assert.equal(c.classifyHost('calendar-pa.clients6.google.com', '/$rpc/x')?.categoria, 'funzionalita');
  // fuori dal percorso degli appuntamenti resta da valutare
  assert.equal(c.classifyHost('calendar.google.com', '/calendar/u/0/r'), undefined);
});
