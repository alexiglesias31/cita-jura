# cita-jura

Checker de citas para **Jura de Nacionalidad** en el Registro Civil de Sevilla.
Scrapea el portal de cita previa de la Junta de Andalucía y notifica por Telegram
cuando aparece un hueco libre.

## Modo de ejecución actual: GitHub Actions

El workflow `.github/workflows/check.yml` corre `node check.js` cada **7 min**
vía cron de GitHub Actions. El repo es **público**, por lo que los minutos
de Actions son ilimitados y gratis.

Secrets requeridos en el repo (Settings → Secrets and variables → Actions):
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Variables opcionales (Settings → Variables):
- `FORCE_NOTIFY=true` para forzar notificación incluso sin huecos (verifica pipeline).

## Local dev

```bash
npm install
npx playwright install chromium   # solo la primera vez
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node check.js
```

Copia `.env.example` → `.env` para más variables.

## Modo servidor (opcional)

`node index.js` arranca un HTTP server que hace `runCheck()` cada
`CHECK_INTERVAL_MS` (default 420000 = 7 min) y expone `/health` y `/check`.
Pensado para hosting persistente (VPS con Chromium del sistema instalado vía
root). En Hostinger Cloud Hosting compartido **no funciona** por glibc viejo
incompatible con cualquier bundle Chromium portable que probamos.

Ver `.env.example` para todas las opciones.

## Estructura

- `check.js` — scraping + Telegram. Reutilizable como CLI o módulo.
- `server.js` — HTTP wrapper con interval interno.
- `index.js` — bootstrap del server.
- `.github/workflows/check.yml` — cron de Actions.
