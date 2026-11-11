# CityMover

**CityMover** is een transport-tycoon in je browser, gespeeld op **echte steden** uit
OpenStreetMap. Je begint met een bescheiden budget in een Nederlandse stad en bouwt
daar een openbaarvervoernetwerk op: van een eerste buslijn tot trams, metro's,
intercitytreinen, snelbussen tussen steden en uiteindelijk vluchten tussen
vliegvelden. Ondertussen rijden er tienduizenden auto's en fietsers door de echte
straten, met files, ongelukken en spitsuren.

## Wat zit erin

- **Echte steden** – wegen, spoor, stations, vliegvelden en bestemmingen komen uit
  OpenStreetMap. Er zijn 38 steden in Nederland, België en Duitsland (Amsterdam,
  Rotterdam, Den Haag, Utrecht, Antwerpen, Brussel, Keulen, Düsseldorf, …).
- **3D-gebouwen en Google-Earth-achtige navigatie** – vrij pannen, zoomen, draaien en
  kantelen boven een 3D-kaart.
- **Zes vervoerwijzen** – bus, tram, metro, trein, snelbus en vliegtuig, elk met eigen
  capaciteit, snelheid, aanschafprijs, exploitatiekosten en infrastructuurkosten.
- **Levels en ontgrendelingen** – je verdient XP met vervoerde reizigers en speelt zo
  nieuwe vervoerwijzen, wegmaatregelen en extra steden vrij.
- **Ticketprijzen en prijselasticiteit** – per lijn stel je een instaptarief en een
  kilometerprijs in. Reizigers kiezen per rit tussen lopen, fietsen, auto en OV
  (logit-keuzemodel op reistijd, wachttijd, kosten en je reputatie): te duur betekent
  minder reizigers.
- **Dienstregeling en spits** – frequenties per dagdeel (nacht, ochtendspits, dal,
  avondspits, avond). De vraag volgt een realistisch Nederlands dagprofiel met pieken
  rond 8:00 en 17:00.
- **Wegen aanpassen** – maximumsnelheid, eenrichtingsverkeer, voorrangsregels
  (voorrang van rechts, voorrangsweg, stopborden), busbanen, aantal rijstroken,
  verkeerslichten en rotondes. Dit beïnvloedt doorstroming én verkeersveiligheid.
- **Ongelukken** – te hoge snelheden en slecht geregelde kruispunten leiden tot
  ongelukken die wegen tijdelijk blokkeren en geld kosten.
- **Regio's en snelwegen** – vanaf level 4 ontgrendel je aangrenzende steden. Tussen
  steden lopen snelwegen waarvan je snelheid (100/120/130 km/u) en aantal rijstroken
  instelt; snelbussen, treinen en vliegtuigen verbinden de steden.
- **Opslaan** – lokaal in je browser, of in de cloud met een account (Supabase).

### Ontgrendelingen (uit `src/config.ts`)

| Level | Ontgrendelt |
|------:|-------------|
| 1 | 🚌 Bus · Maximumsnelheid · Eenrichtingsverkeer · Voorrangsregels |
| 2 | Busbanen · Rijstroken · Verkeerslichten |
| 3 | 🚋 Tram · Rotondes |
| 4 | 🚍 Snelbus · Tweede stad · Snelwegen |
| 5 | 🚇 Metro |
| 6 | 🚆 Trein |
| 10 | ✈️ Vliegtuig |

- Startkapitaal: **€ 1.500.000**.
- Benodigde XP voor level *L*: `350 × (L − 1)^1,75` (level 2 = 350 XP, level 4 ≈ 2.400 XP,
  level 10 ≈ 16.000 XP).
- Aantal steden: 1 tot level 4, daarna 2 + 1 extra per 2 levels.
- Een nieuwe stad kost ongeveer `€ 400.000 × √(inwoners / 150.000)` en moet grenzen aan
  een stad die je al hebt.
- Startsteden: Amsterdam, Rotterdam, Den Haag, Utrecht, Eindhoven, Groningen, Haarlem,
  Leiden en Delft.

## Techniek

- **TypeScript** (strict) + **Vite**.
- **MapLibre GL JS** met vector tiles van **OpenFreeMap** voor de basiskaart en
  3D-gebouwen (fill-extrusion).
- **deck.gl** (instanced/binary attribute layers) bovenop MapLibre om tienduizenden
  voertuigen, auto's, fietsers en reizigers per frame te tekenen.
- **Overpass API** voor de OSM-wegen-, spoor- en POI-data per stad. Opgehaalde data
  wordt gecachet in **IndexedDB**, zodat een stad maar één keer gedownload hoeft te
  worden. Volgorde: IndexedDB-cache → meegeleverd `public/data/<id>.json` → Overpass.
- **Simulatie in structure-of-arrays** (typed arrays) met een eigen binaire heap voor
  routeplanning over het wegennet en het OV-netwerk.
- **Supabase** (optioneel) voor accounts en cloud-saves; zonder configuratie valt het
  spel terug op `localStorage`.

## Starten

Vereist: **Node.js 22** of nieuwer.

```bash
npm install
npm run dev       # ontwikkelserver op http://localhost:5173
npm run build     # typecheck + productie-build naar dist/
npm run preview   # de build lokaal bekijken
```

Zonder verdere configuratie werkt alles meteen; voortgang wordt dan alleen lokaal in je
browser bewaard (gebruiker "lokaal").

## Cloud-saves met Supabase (stap voor stap)

Met Supabase kun je inloggen met e-mail en wachtwoord en je voortgang op elk apparaat
verderspelen. Het gratis abonnement is ruim voldoende.

1. **Project aanmaken** – ga naar [supabase.com](https://supabase.com), log in en klik op
   **New project**. Kies een naam, een databasewachtwoord en een regio (bijv.
   *West EU (Ireland)* of *Central EU (Frankfurt)*). Wacht tot het project klaar is.
2. **Sleutels kopiëren** – ga naar **Project Settings → API** (in nieuwere versies ook via
   de knop **Connect** of **Project Settings → API Keys**). Kopieer:
   - de **Project URL** (`https://xxxxxxxx.supabase.co`)
   - de **anon public** key (in nieuwere projecten heet die *publishable key*).

   Gebruik **nooit** de `service_role`/secret key in de frontend.
3. **`.env.local` maken** in de hoofdmap van het project (kopieer `.env.example`):

   ```bash
   VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```

   `.env.local` staat in `.gitignore` en komt dus niet in git.
4. **Database-tabel aanmaken** – open in Supabase de **SQL Editor** → **New query**, plak
   de volledige inhoud van [`supabase/schema.sql`](supabase/schema.sql) en klik op
   **Run**. Dit maakt de tabel `public.saves` (één rij per gebruiker), zet Row Level
   Security aan met policies zodat iedereen alleen zijn eigen save kan lezen en
   schrijven, en voegt een `updated_at`-trigger toe. Het script mag je gerust opnieuw
   uitvoeren.
5. **E-mail-login instellen** – ga naar **Authentication → Sign In / Providers** en
   controleer dat **Email** aan staat. Daarna:
   - *Snel testen:* zet **Confirm email** uit. Nieuwe accounts kunnen dan direct
     inloggen.
   - *Productie:* laat **Confirm email** aan en ga naar **Authentication → URL
     Configuration**. Zet de **Site URL** op het adres waar je het spel host (bijv.
     `https://<gebruiker>.github.io/<repo>/`) en voeg bij **Redirect URLs** zowel dat
     adres als `http://localhost:5173/` toe. De bevestigingsmail stuurt spelers dan terug
     naar het spel.
   - Let op: de ingebouwde mailserver van Supabase verstuurt maar een paar mails per uur.
     Voor serieus gebruik stel je onder **Authentication → Emails → SMTP Settings** een
     eigen SMTP-server in.
6. **Ontwikkelserver herstarten** – stop `npm run dev` en start hem opnieuw; Vite leest
   `.env.local` alleen bij het opstarten. Het inlogscherm gebruikt nu Supabase.
7. **Bij deployen** – zet dezelfde twee variabelen (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`) in je hostingplatform: Netlify (*Site configuration →
   Environment variables*), Vercel (*Settings → Environment Variables*) of als
   repository-secrets voor GitHub Actions (zie hieronder). Het zijn build-time
   variabelen: na het wijzigen opnieuw builden.

### Hoe het opslaan werkt

- Elke save wordt **eerst lokaal** (localStorage) als backup bewaard en daarna naar
  Supabase geüpload (`upsert` in `saves`, één rij per gebruiker). Mislukt de upload
  (bijv. geen internet), dan gaat er niets verloren.
- Bij het laden wordt de cloud-save vergeleken met de lokale backup; de **nieuwste** wint
  (op basis van een `savedAt`-tijdstempel). Is de lokale backup nieuwer, dan wordt die
  meteen opnieuw naar de cloud gestuurd.
- Snel achter elkaar opslaan wordt samengevoegd: er loopt maximaal één upload tegelijk.
- Foutmeldingen van Supabase worden in het Nederlands getoond ("Ongeldige
  inloggegevens", "Bevestig eerst je e-mailadres", …).

## Deployen

Het spel is een statische site (`vite.config.ts` gebruikt `base: './'`), dus het werkt op
elke statische host en in elke submap.

### GitHub Pages (meegeleverde workflow)

In [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) staat een workflow die
bij elke push naar `main` bouwt en publiceert.

1. Ga in je GitHub-repository naar **Settings → Pages** en kies bij **Source** voor
   **GitHub Actions**.
2. (Optioneel, voor cloud-saves) ga naar **Settings → Secrets and variables → Actions →
   New repository secret** en maak twee secrets aan: `VITE_SUPABASE_URL` en
   `VITE_SUPABASE_ANON_KEY`.
3. Push naar `main` (of start de workflow handmatig via **Actions → Deploy naar GitHub
   Pages → Run workflow**). Het spel staat daarna op
   `https://<gebruiker>.github.io/<repo>/`.
4. Zet die URL in Supabase als Site URL / Redirect URL (stap 5 hierboven).

### Netlify / Vercel

- Build command: `npm run build`
- Publish/output directory: `dist`
- Environment variables: `VITE_SUPABASE_URL` en `VITE_SUPABASE_ANON_KEY` (optioneel)

## Steden vooraf downloaden

Normaal haalt het spel de kaartdata bij de eerste keer laden op via de Overpass API (dat
kan bij grote steden even duren) en bewaart die in IndexedDB. Je kunt steden ook vooraf
downloaden en meeleveren, zodat ze sneller en zonder Overpass laden:

```bash
node scripts/fetch-city.ts amsterdam             # via de Overpass API
node scripts/fetch-city.ts delft --osmapi        # via de OSM API 0.6 (alleen kleine steden)
node scripts/fetch-city.ts utrecht --radius=2.5  # ander speelgebied (km)
```

Dit schrijft `public/data/<id>.json`, dat bij de build wordt meegenomen. **Delft** zit al
standaard bij het project. De beschikbare id's staan in `src/data/cities.ts` (bijv.
`amsterdam`, `rotterdam`, `denhaag`, `utrecht`, `antwerpen`, `brussel`, `keulen`).
Node 22.18+ voert `.ts`-bestanden direct uit; op oudere Node 22-versies gebruik je
`node --experimental-strip-types scripts/fetch-city.ts <id>`.

Tip: na het bijwerken van een meegeleverde stad moet je de IndexedDB-cache van je
browser legen (DevTools → Application → IndexedDB → `citymover`) om de nieuwe data te
zien.

## Spelen

1. **Kies een startstad** en log in (of speel lokaal).
2. **Navigeren** zoals in Google Earth: slepen om te verschuiven, scrollen om te zoomen,
   rechtermuisknop (of Ctrl + slepen) om te draaien en te kantelen. Op touchscreens:
   knijpen om te zoomen, met twee vingers draaien/kantelen.
3. **Lijn bouwen**: kies een vervoerwijze, klik haltes op de kaart (ze snappen naar weg,
   spoor, station of vliegveld) en bevestig. Koop daarna voertuigen voor de lijn.
4. **Dienstregeling en prijzen**: stel per lijn de frequentie per dagdeel en het tarief
   (instaptarief + prijs per km) in.
5. **Wegen**: in de wegenmodus klik je op een weg of kruispunt om snelheid, richting,
   rijstroken, busbaan of voorrangsregeling aan te passen. Gebruik de overlays
   (drukte, veiligheid, vraag) om knelpunten te vinden.
6. **Uitbreiden**: vanaf level 4 ontgrendel je aangrenzende steden en stel je snelwegen
   in; verbind steden met snelbussen, treinen en later vliegtuigen.

**Tips**

- Begin met één goede buslijn tussen het station en het centrum: daar zit de meeste vraag.
- Zet in de spits meer voertuigen in; 's nachts kun je de frequentie flink omlaag doen
  om kosten te besparen.
- Haltes moeten bij woningen en bestemmingen liggen: kijk naar de vraag-overlay.
- Een busbaan op een drukke weg maakt je bussen ongevoelig voor files.
- Lagere snelheden en verkeerslichten/rotondes op gevaarlijke kruispunten verminderen
  ongelukken.
- Te hoge ticketprijzen jagen reizigers terug in de auto (en vergroten de files).

## Projectstructuur

```
src/
  config.ts       balans: vervoerwijzen, kosten, levels, features, keuzemodel
  geo.ts          gedeelde projectie (meters) en spatial grid
  data/cities.ts  steden (coördinaten, inwoners, vliegvelden) en buursteden
  osm/            OpenStreetMap: Overpass-queries, parser, IndexedDB-cache
  sim/            simulatie: wegengraaf, verkeer (SoA-pools), OV-lijnen, routeplanner
  game/           spelregels, economie, levels, snelwegen; api.ts = gedeeld contract
  render/         MapLibre + deck.gl renderer (3D-kaart, voertuigen, overlays)
  ui/             interface (panelen, menu's, meldingen)
  save/           opslaan: Supabase of localStorage-fallback
  main.ts         opstarten en game loop
scripts/
  fetch-city.ts   stad vooraf downloaden naar public/data/<id>.json
public/data/      meegeleverde stadsdata (delft.json)
supabase/
  schema.sql      tabel + RLS-policies voor cloud-saves
```

## Bronvermelding en licentie

- Kaart- en stadsdata © [OpenStreetMap](https://www.openstreetmap.org/copyright)-bijdragers,
  beschikbaar onder de **Open Database License (ODbL)**. De meegeleverde en gecachete
  stadsbestanden (`public/data/*.json`) zijn afgeleide databases en vallen daarom ook
  onder de ODbL; vermeld OpenStreetMap als je ze verspreidt.
- Kaarttegels: [OpenFreeMap](https://openfreemap.org) (data © OpenMapTiles,
  © OpenStreetMap-bijdragers).
- Gebruik de publieke Overpass-servers met mate; download grote steden bij voorkeur één
  keer vooraf met `scripts/fetch-city.ts`.
