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

## Příklad: Tišnov → Hrnčířská (vlak + tramvaj)

Jeden watch = jedna noha cesty (odjezdy ze zastávky filtrované podle **cíle spoje**).
Přestup Tišnov → Královo Pole → Hrnčířská tedy potřebuje **dva watch**:

```text
# 1) vlak — cíl spoje je typicky Brno hl.n., ne Královo Pole
PUT /watch/Tišnov/Brno?od=06:30&do=08:30&webhook=https://trigger.macrodroid.com/.../vlak&minDelay=5

# 2) tramvaj z Králova Pole na Hrnčířskou
PUT /watch/Královo_Pole/Hrnčířská?od=06:30&do=08:30&webhook=https://trigger.macrodroid.com/.../tramvaj&minDelay=5
```

Mapování jmen:
- `Tišnov` → Tišnov, železniční stanice
- `Královo_Pole` / `Královo Pole` → Královo Pole, nádraží
- `Hrnčířská` → Hrnčířská

V MacroDroidu buď dvě makra (dvě webhook URL), nebo jedno makro a oba `PUT` na stejný webhook — trasu poznáš z polí `from` / `to`.

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
3. Worker každou minutu zkontroluje spoje; na MacroDroid pošle JSON **jen při nové události** (zpoždění / zrušení / výluka), ať endpoint nezahlcuješ.

### Oznámení

Přidej akci **Oznámení** (Display Notification):

| Pole | Hodnota |
| --- | --- |
| Titulek | `{title}` nebo napevno `Vlaky / MHD` |
| Text | `{message}` (stejný obsah má i `{text}`) |

Příklady textu z backendu:
- `ZPOŽDĚNÍ +7 min S3 → Brno hl.n. (07:51)`
- `ZRUŠENO S3 → Brno hl.n.`
- `Bez zpoždění/zrušení na …` (test s `push=1`)

Další JSON pole: `from`, `to`, `timeFrom`, `timeTo`, `alertText`, `noteworthy`, `departures`, `alerts`.

Vlastní text (volitelně):

```text
{from} → {to}
{message}
```

Když `{message}` zůstane prázdné, zapni u webhooku předávání JSON parametrů / akci **JSON Parse** na tělo requestu.

### Test notifikace

```bash
curl "http://127.0.0.1:8787/watch/Tišnov/Brno?od=06:00&do=09:00&webhook=MACRODROID_URL&minDelay=5&push=1"
```

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
