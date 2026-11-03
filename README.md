# train-notifications

Cloudflare Worker pro sledování zpoždění / výluk IDS JMK (KORDIS) s push webhooky do MacroDroidu.

Sledování se nastavuje **přímo v cestě URL**:

```text
/watch/{od}/{do}?od=HH:MM&do=HH:MM&webhook=MACRODROID_URL&minDelay=5
```

## Příklad: Tišnov → Brno

```text
# jen stav (JSON)
GET /watch/Tišnov/Brno?od=06:30&do=08:30

# zaregistrovat push do MacroDroidu
PUT /watch/Tišnov/Brno?od=06:30&do=08:30&webhook=https://trigger.macrodroid.com/...&minDelay=5

# zrušit
DELETE /watch/Tišnov/Brno?od=06:30&do=08:30&webhook=https://trigger.macrodroid.com/...
```

| Část | Význam |
| --- | --- |
| `/watch/{od}/{do}` | Stanice odkud / kam |
| `od`, `do` | Časové okno odjezdů (`HH:MM`) |
| `webhook` | MacroDroid incoming webhook |
| `minDelay` | Práh zpoždění v minutách (default `5`) |

Mezery ve jménech zastávek: `%20` nebo `_`.

## Lokálně

```bash
npm install
npm run build:stops   # jednorázově katalog zastávek z GTFS KORDIS
npm run dev
```

Ověření:

```bash
curl "http://127.0.0.1:8787/watch/Tišnov/Brno?od=06:00&do=12:00"
curl -X POST "http://127.0.0.1:8787/run"
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?format=json"
```

## MacroDroid

1. Vytvoř trigger *Webhook (URL)* a zkopíruj URL.
2. Zaregistruj sledování přes `PUT` výše.
3. Worker každou minutu zkontroluje spoje; při nové události pošle JSON.

Užitečná pole: `text` / `message`, `noteworthy`, `departures`, `alerts`.

## Data

- Odjezdy: IDS JMK board API, fallback `dpmbinfo` (stejný feed jako mapa IDS JMK)
- Výluky: otevřená data Brna (IDS JMK výluky/odklony)
- Zpoždění: explicitní `+N` z boardu, jinak skluz live odhadu mezi kontrolami u registrovaných watchů

## Deploy

```bash
npx wrangler kv namespace create WATCHES
# doplň id do wrangler.toml
npm run deploy
```
