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

# seznam sledování pro webhook (nebo všechna bez filtru)
GET /watches?webhook=https://trigger.macrodroid.com/...

# zrušit podle id ze seznamu
DELETE /watches/{id}
```

| Část | Význam |
| --- | --- |
| `/watch/{od}/{do}` | Stanice odkud / kam |
| `od`, `do` | Časové okno odjezdů (`HH:MM`) |
| `webhook` | MacroDroid incoming webhook |
| `minDelay` | Práh zpoždění v minutách; bez parametru / prázdné = jen zrušení spojů |
| `GET /watches?webhook=` | Seznam jen pro danou MacroDroid URL (bez `webhook` nic nevrací) |
| `DELETE /watches/{id}?webhook=` | Smazání konkrétního sledování (stejná URL musí sedět) |

Mezery ve jménech zastávek: `%20` nebo `_`.

## Příklad: Tišnov → Hrnčířská (vlak + tramvaj)

Jeden watch = jedna noha cesty (odjezdy ze zastávky filtrované podle **cíle spoje**).
Přestup Tišnov → Královo Pole → Hrnčířská tedy potřebuje **dva watch**:

```text
# 1) vlak — cíl spoje je typicky Brno hl.n., ne Královo Pole
PUT /watch/Tišnov/Královo_Pole?od=06:30&do=08:30&webhook=https://trigger.macrodroid.com/.../vlak&minDelay=5

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
2. U webhooku ulož **parametry do slovníku** `params` (ne tělo requestu — Worker posílá GET bez body).
3. Zaregistruj sledování přes `PUT` výše.
4. Worker každou minutu zkontroluje spoje; na MacroDroid pošle požadavek **jen při nové události** (zpoždění / zrušení / výluka).

Worker volá MacroDroid jako **GET s query parametry** (`message`, `title`, `from`, `to`, …).

### Oznámení

V akci **Oznámení** musí být text:

```text
{lv=params[message]}
```

| Pole | Hodnota |
| --- | --- |
| Titulek | `{lv=params[title]}` nebo napevno `Vlaky / MHD` |
| Text | **`{lv=params[message]}`** |

Samotné `{message}` nestačí — parametry jsou ve slovníku `params` (stejný princip jako u jiných webhooků, např. `{lv=baterie-ocs[level]}`).

Příklady textu z backendu:
- `ZPOŽDĚNÍ +7 min S3 07:51 z Tišnov do Brno`
- `ZRUŠENO S3 07:51 z Tišnov do Brno`
- `Bez zpoždění z Tišnov do Brno` (test s `push=1`)

Pozn.: u vlaků je v textu označení linky (S3), board IDS JMK typicky neposílá ČD číslo vlaku.

Další klíče: `from`, `to`, `timeFrom`, `timeTo`, `alertText`, `checkedAt`.

### Test notifikace

```bash
curl.exe --get "http://127.0.0.1:8787/watch/Tisnov/Brno" --data-urlencode "od=06:00" --data-urlencode "do=09:00" --data-urlencode "webhook=MACRODROID_URL" --data-urlencode "push=1"
```

## Data

- Odjezdy: IDS JMK board API, fallback `dpmbinfo` (stejný feed jako mapa IDS JMK)
- Výluky: otevřená data Brna (IDS JMK výluky/odklony)
- Zpoždění: explicitní `+N` z boardu, jinak skluz live odhadu mezi kontrolami u registrovaných watchů
- Zastávky: denní import GTFS KORDIS do storage (`catalog:stops`); bez záznamu platí bundle z deploye
- Úložiště: Durable Object (`STORAGE_BACKEND=do`, výchozí) nebo Workers KV (`STORAGE_BACKEND=kv`)

## Webovka (Cloudflare Worker Assets)

UI je ve složce `docs/` a nasazuje se spolu s Workerem (Assets). Produkční URL je stejná
jako API: `https://train-notifications.<subdomain>.workers.dev`.

1. Lokálně: `npm run dev` — UI i API na `http://127.0.0.1:8787`.
   Alternativa: `npx serve docs` + Worker zvlášť (API na `:8787`, CORS je zapnuté).
2. Stanice **Od** / **Do** vybírej z nápovědy (katalog IDS JMK).
3. Vyplň časové okno a MacroDroid webhook → **Uložit** / **Test push**.

Seznam zastávek bere UI z `GET /api/stops` (katalog ve storage, fallback na zapečený bundle).
Worker ho jednou denně (03:00 UTC) přegeneruje z GTFS KORDIS; ručně: `POST /api/refresh-stops`.
Lokální seed / fallback bundle: `npm run build:stops`.
Krátké API usage JSON: `GET /api` (včetně `storage: "do"|"kv"`).

Přepínač backendu v `wrangler.toml` → `[vars]` → `STORAGE_BACKEND`:
- `do` — Durable Object (nežere Free KV write kvótu; při prvním startu jednorázově zkopíruje data z KV)
- `kv` — původní Workers KV (limit ~1000 zápisů/den na Free)

### Privátní přístup (Cloudflare Access)

Celý hostname zamkni přes Zero Trust Access, ať UI i API vidíš jen ty.
Cron (push do MacroDroidu) Access neprochází.

1. Po deployi otevři [Cloudflare Zero Trust](https://one.dash.cloudflare.com)
2. **Access** → **Applications** → **Add an application** → **Self-hosted**
3. Application domain: `train-notifications.<subdomain>.workers.dev` (celý hostname)
4. Policy: **Allow** → Include → **Emails** → tvůj e-mail
5. Login: One-time PIN (e-mail) nebo Google

Veřejný GitHub Pages vypni (**Settings → Pages → None**), ať nezůstane otevřená kopie.

## Deploy Workeru

```bash
npx wrangler kv namespace create WATCHES
# doplň id do wrangler.toml (KV zůstává kvůli STORAGE_BACKEND=kv / migraci)
npm run deploy
```
