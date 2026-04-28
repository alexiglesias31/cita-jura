# cita-jura

Checker de citas para **Jura de Nacionalidad** en el Registro Civil de Sevilla.
Scrapea el portal de cita previa de la Junta de Andalucía y notifica por Telegram
cuando aparece un hueco libre.

## Modos de ejecución

| Modo | Comando | Uso |
|------|---------|-----|
| Script único | `node check.js` | Una pasada, ideal para cron jobs |
| Servidor HTTP + interval | `node index.js` | App Node.js persistente (Hostinger, VPS) |

## Configuración

Copia `.env.example` → `.env` y rellena al menos `TELEGRAM_BOT_TOKEN` y
`TELEGRAM_CHAT_ID`. Variables relevantes:

- `CHECK_INTERVAL_MS` — intervalo del modo servidor (por defecto **420000 = 7 min**).
- `USE_SPARTICUZ` — `true` en hostings tipo Hostinger / CloudLinux que no traen las
  libs nativas que pide el Chromium de Playwright. Usa el binario portable de
  `@sparticuz/chromium`.
- `TRIGGER_KEY` — secreto opcional para proteger `/check?key=...`.

## Local dev

```bash
npm install
npx playwright install chromium   # solo la primera vez
node check.js                     # ejecución única
node index.js                     # servidor con interval
```

`USE_SPARTICUZ` debe quedar **sin setear** en local (Mac/Win) — Playwright usa
su propio Chromium descargado.

## Deploy en Hostinger (Cloud Hosting / Business)

El plan de Cloud Hosting de Hostinger no permite instalar las libs del sistema
que el Chromium de Playwright necesita (`libnss3`, `libatk`, etc.), por eso esta
versión usa `@sparticuz/chromium`, un binario portable que las trae empaquetadas.

1. **hPanel → Avanzado → Aplicaciones Node.js → Crear**.
   - Versión Node.js: **20.x** (mínimo 18).
   - Carpeta de la app: `cita-jura` (o lo que prefieras).
   - Archivo de inicio: `index.js`.
2. **Subir el código** (git clone vía SSH, o subir el zip).
3. **Variables de entorno** (en la misma pantalla de la app):
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   USE_SPARTICUZ=true
   CHECK_INTERVAL_MS=420000
   HEADLESS=true
   ```
4. **Instalar dependencias** desde la UI (botón "NPM install") o por SSH:
   ```bash
   cd ~/cita-jura
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund
   ```
   El flag evita que Playwright intente descargar su Chromium (~150 MB que no
   funcionaría igual). Usaremos el binario de `@sparticuz/chromium` que sí
   se descarga con `npm install`.
5. **Arrancar** desde la UI ("Start App"). Hostinger mantendrá vivo el proceso
   y reiniciará si se cae.
6. **Verificar**: `https://tu-dominio/health` debe devolver JSON con
   `intervalMs: 420000`.

### Si `USE_SPARTICUZ=true` también falla

Lo más probable es un mismatch de glibc. Mira los logs de Hostinger; si ves
`GLIBC_X.Y not found`, fija una versión más antigua de `@sparticuz/chromium`
(p.ej. `@sparticuz/chromium@121.0.0`) o usa Hostinger VPS en lugar de Cloud
Hosting (allí sí puedes instalar libs como root).

## GitHub Actions

El workflow `.github/workflows/check.yml` quedó en modo **manual** (sólo
`workflow_dispatch`). Sirve como smoke test desde la UI de Actions sin gastar
minutos del plan gratis.
