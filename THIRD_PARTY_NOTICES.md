# Componenti di terze parti

Scookie è software proprietario (© 2026 Filippo Pirini, vedi `LICENSE`), destinato all'uso del titolare.
Usa i componenti seguenti, tutti con licenze permissive: ne consentono l'uso anche in software proprietario e commerciale,
a condizione di conservarne le note di copyright e di licenza.
`npm run licenses` verifica automaticamente le licenze di tutte le dipendenze installate (dirette e transitive)
e fallisce se ne trova una non ammessa.

## Dati inclusi nel repository

| Componente | Licenza | Uso | Dove |
| --- | --- | --- | --- |
| [Open Cookie Database](https://github.com/jkwakman/Open-Cookie-Database) (© jkwakman e contributori) | Apache-2.0 | Classificazione dei cookie per nome | `data/vendor/open-cookie-database.csv`, licenza in `data/vendor/LICENSE-open-cookie-database` |

Il file è una copia non modificata, scaricata il 23/10/2026. Per aggiornarlo:

```sh
curl -sSf https://raw.githubusercontent.com/jkwakman/Open-Cookie-Database/master/open-cookie-database.csv -o data/vendor/open-cookie-database.csv
```

`data/trackers.yaml` è stato redatto per questo progetto (stessi diritti del resto del codice) e **non** deriva da elenchi con licenze
non commerciali o copyleft.

## Dipendenze npm (runtime)

| Pacchetto | Licenza |
| --- | --- |
| playwright / playwright-core | Apache-2.0 |
| commander | MIT |
| tldts / tldts-core (lista dei suffissi pubblici) | MIT |
| yaml | ISC |
| zod | MIT |

## Componenti esclusi di proposito

| Componente | Motivo |
| --- | --- |
| DuckDuckGo Tracker Radar | CC BY-NC-SA 4.0: uso commerciale non consentito |
| Disconnect tracking protection list | licenza non commerciale |
| EasyList / EasyPrivacy | GPL-3.0 / CC BY-SA: copyleft |
| EDPS Website Evidence Collector | EUPL-1.2: copyleft. Si può usare come strumento esterno di verifica incrociata, senza includerne il codice |
| @duckduckgo/autoconsent | MPL-2.0: compatibile con l'uso commerciale ma copyleft a livello di file; non incluso per ora, si può aggiungere in futuro come modulo opzionale |
