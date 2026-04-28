import { chromium } from 'playwright';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createBrotliDecompress } from 'node:zlib';

const require = createRequire(import.meta.url);

async function brotliDecompress(srcBr, dstFile) {
  await pipeline(
    createReadStream(srcBr),
    createBrotliDecompress(),
    createWriteStream(dstFile),
  );
}

function extractTar(tarFile, destDir) {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', tarFile, '-C', destDir], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`tar -xf ${tarFile} failed: ${r.stderr?.toString() ?? ''}`);
  }
}

// Hostinger shared/cloud hosting (CloudLinux) lacks the system libraries that
// Playwright's bundled Chromium needs. @sparticuz/chromium ships a portable
// Chromium build with the required libs statically linked. Enable with
// USE_SPARTICUZ=true in production; on local dev (Mac/Win) leave it unset and
// Playwright uses its own bundled browser.
const USE_SPARTICUZ = process.env.USE_SPARTICUZ === 'true';

const URL = 'https://www.juntadeandalucia.es/justicia/citaprevia/?idCliente=4';

const OFFICE = process.env.OFFICE_NAME ?? 'REGISTRO CIVIL EXCLUSIVO N.º 1 DE SEVILLA';
const TRAMITE = process.env.TRAMITE_NAME ?? 'REQUISITOS JURAMENTO/PROMESA NACIONALIDAD POR RESIDENCIA';
const MAX_MONTHS = Number.parseInt(process.env.MAX_MONTHS ?? '6', 10);
const HEADLESS = process.env.HEADLESS !== 'false';
const DEBUG_DIR = process.env.DEBUG_DIR ?? 'debug';
const SAVE_DEBUG = process.env.SAVE_DEBUG === 'true';
// TEMP: force a Telegram message even when no slots are found, to verify the pipeline.
const FORCE_NOTIFY = process.env.FORCE_NOTIFY === 'true';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function notifyTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log('[telegram not configured] would send:\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram API error ${res.status}: ${await res.text()}`);
  }
  log('Telegram notification sent');
}

async function selectOptionByText(page, selectLocator, visibleText) {
  const value = await selectLocator.evaluate((sel, text) => {
    const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
    const target = norm(text);
    const options = Array.from(sel.options);
    const exact = options.find((o) => norm(o.text) === target);
    const partial = options.find((o) => norm(o.text).includes(target));
    const pick = exact ?? partial;
    if (!pick) {
      const avail = options.map((o) => o.text.trim());
      throw new Error(`Option not found: "${text}". Available:\n - ${avail.join('\n - ')}`);
    }
    return pick.value;
  }, visibleText);
  await selectLocator.selectOption(value);
}

async function findOfficeSelect(page) {
  return page
    .locator('select')
    .filter({ has: page.locator('option', { hasText: /REGISTRO CIVIL/i }) })
    .first();
}

async function findTramiteSelect(page) {
  return page
    .locator('select')
    .filter({
      has: page.locator('option', {
        hasText: /REQUISITOS|INSCRIPCI[ÓO]N|OTROS TR[ÁA]MITES/i,
      }),
    })
    .first();
}

async function readCalendarState(page) {
  return page.evaluate(() => {
    const titleEl = document.querySelector('.ui-datepicker-title');
    // The Junta's datepicker renders month/year as <select> elements inside
    // .ui-datepicker-title. textContent on the container concatenates every
    // <option>, yielding garbage like "AbrMayJun...202620272028". Prefer the
    // selected option labels; fall back to plain textContent otherwise.
    let title = null;
    if (titleEl) {
      const monthSel = titleEl.querySelector('select.ui-datepicker-month');
      const yearSel = titleEl.querySelector('select.ui-datepicker-year');
      const month = monthSel?.selectedOptions?.[0]?.textContent?.trim();
      const year = yearSel?.selectedOptions?.[0]?.textContent?.trim();
      if (month && year) {
        title = `${month} ${year}`;
      } else {
        title = titleEl.textContent.trim().replace(/\s+/g, ' ');
      }
    }
    const cells = Array.from(document.querySelectorAll('.ui-datepicker-calendar td'));
    const clickable = cells
      .filter((td) => {
        if (td.classList.contains('ui-datepicker-unselectable')) return false;
        if (td.classList.contains('ui-state-disabled')) return false;
        return !!td.querySelector('a');
      })
      .map((td) => td.textContent.trim());
    const nextDisabled = !document.querySelector('.ui-datepicker-next:not(.ui-state-disabled)');
    return {
      title,
      clickable,
      nextDisabled,
    };
  });
}

async function detectSlotsForDay(page) {
  // Wait a moment for any ajax repaint after clicking a day
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    const noSlots = /no hay huecos libres/.test(bodyText);
    // Common patterns for time slot pickers in the Junta de Andalucía cita previa system
    const candidates = [
      'input[type="radio"][name*="hora" i]',
      'input[type="radio"][id*="hora" i]',
      'button.hueco',
      'a.hueco',
      '.horaLibre',
      '.hueco-libre',
      '.horasLibres input',
      'select[name*="hora" i] option[value]:not([value=""])',
    ];
    let slotCount = 0;
    for (const sel of candidates) {
      slotCount += document.querySelectorAll(sel).length;
    }
    return { noSlots, slotCount };
  });
}

async function saveDebug(page, name) {
  if (!SAVE_DEBUG) return;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: `${DEBUG_DIR}/${name}.png`, fullPage: true });
    const html = await page.content();
    writeFileSync(`${DEBUG_DIR}/${name}.html`, html);
  } catch (err) {
    log('debug save failed:', err.message);
  }
}

export async function runCheck() {
  const startedAt = new Date().toISOString();
  log(`Starting check. office="${OFFICE}" tramite="${TRAMITE}" months=${MAX_MONTHS} headless=${HEADLESS} sparticuz=${USE_SPARTICUZ}`);
  const launchOpts = { headless: HEADLESS };
  if (USE_SPARTICUZ) {
    // @sparticuz/chromium hardcodes extraction to /tmp (designed for AWS
    // Lambda) and Hostinger CloudLinux mounts /tmp with noexec. Worse,
    // sparticuz early-returns when /tmp/chromium exists without re-extracting
    // sibling lib dirs that Hostinger may have purged. So we bypass its
    // extraction logic entirely and unpack the brotli/tar files shipped in
    // the package directly into a writable+execable dir under the app root.
    const tmpDir = process.env.SPARTICUZ_TMPDIR ?? path.resolve('.tmp-chromium');
    mkdirSync(tmpDir, { recursive: true });
    const sparticuzPkg = require.resolve('@sparticuz/chromium/package.json');
    const sparticuzBin = path.join(path.dirname(sparticuzPkg), 'bin');
    const localExec = path.join(tmpDir, 'chromium');
    if (!existsSync(localExec)) {
      log(`Extracting chromium.br -> ${localExec}`);
      await brotliDecompress(path.join(sparticuzBin, 'chromium.br'), localExec);
    }
    chmodSync(localExec, 0o755);
    for (const archive of ['al2023.tar.br', 'al2.tar.br', 'swiftshader.tar.br', 'fonts.tar.br']) {
      const src = path.join(sparticuzBin, archive);
      if (!existsSync(src)) continue;
      const baseName = archive.replace(/\.tar\.br$/, '');
      const destDir = path.join(tmpDir, baseName);
      if (existsSync(destDir)) continue;
      const tarPath = path.join(tmpDir, `${baseName}.tar`);
      log(`Extracting ${archive} -> ${destDir}`);
      await brotliDecompress(src, tarPath);
      extractTar(tarPath, destDir);
      rmSync(tarPath, { force: true });
    }
    process.env.LD_LIBRARY_PATH = [
      path.join(tmpDir, 'al2023', 'lib'),
      path.join(tmpDir, 'al2', 'lib'),
      path.join(tmpDir, 'swiftshader'),
      tmpDir,
      process.env.LD_LIBRARY_PATH || '',
    ]
      .filter(Boolean)
      .join(':');
    process.env.FONTCONFIG_PATH = path.join(tmpDir, 'fonts');
    // Playwright uses os.tmpdir() for the ephemeral user-data-dir. Default
    // /tmp on CloudLinux is noexec and Chromium SIGSEGVs on mmap of profile
    // .pak files. Redirect tmp to our execable dir.
    process.env.TMPDIR = tmpDir;
    process.env.TMP = tmpDir;
    process.env.TEMP = tmpDir;
    const { default: sparticuzChromium } = await import('@sparticuz/chromium');
    log(
      `Sparticuz Chromium ready. exec=${localExec} ` +
        `LD_LIBRARY_PATH=${process.env.LD_LIBRARY_PATH}`,
    );
    launchOpts.executablePath = localExec;
    launchOpts.args = sparticuzChromium.args;
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  });
  const page = await context.newPage();
  const found = [];
  const monthsScanned = [];

  try {
    log(`Navigating to ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const officeSelect = await findOfficeSelect(page);
    await officeSelect.waitFor({ state: 'visible', timeout: 30000 });
    log('Selecting office');
    await selectOptionByText(page, officeSelect, OFFICE);

    log('Waiting for trámite list to include desired option');
    await page.waitForFunction(
      (needle) => {
        const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
        const target = norm(needle);
        return Array.from(document.querySelectorAll('select option')).some((o) =>
          norm(o.textContent).includes(target),
        );
      },
      TRAMITE,
      { timeout: 30000 },
    );

    const tramiteSelect = await findTramiteSelect(page);
    log('Selecting trámite');
    await selectOptionByText(page, tramiteSelect, TRAMITE);

    await saveDebug(page, '01-step1-filled');

    log('Clicking Continuar');
    const continuar = page
      .getByRole('button', { name: /continuar/i })
      .or(
        page.locator(
          'input[type="submit"][value*="Continuar" i], input[type="button"][value*="Continuar" i], a:has-text("Continuar")',
        ),
      )
      .first();
    await continuar.click();

    log('Waiting for calendar');
    await page.waitForSelector('.ui-datepicker-calendar', { timeout: 45000 });
    await saveDebug(page, '02-calendar');

    for (let i = 0; i < MAX_MONTHS; i++) {
      const state = await readCalendarState(page);
      log(`Month ${state.title ?? '?'}: ${state.clickable.length} clickable day(s) [${state.clickable.join(', ')}]`);
      monthsScanned.push({ title: state.title, clickable: state.clickable.slice() });

      for (const day of state.clickable) {
        const dayLink = page
          .locator('.ui-datepicker-calendar td:not(.ui-datepicker-unselectable)')
          .locator('a', { hasText: new RegExp(`^\\s*${day}\\s*$`) })
          .first();
        try {
          await dayLink.click({ timeout: 5000 });
        } catch (err) {
          log(`  could not click day ${day}: ${err.message}`);
          continue;
        }
        const { noSlots, slotCount } = await detectSlotsForDay(page);
        if (!noSlots && slotCount > 0) {
          log(`  ✔ ${day} ${state.title}: ${slotCount} slot(s)`);
          found.push({ month: state.title, day, slots: slotCount });
          await saveDebug(page, `slots-${state.title?.replace(/\s+/g, '-')}-${day}`);
        } else {
          log(`  ✗ ${day} ${state.title}: no slots (msg=${noSlots} count=${slotCount})`);
        }
      }

      if (state.nextDisabled) {
        log('No more months available from calendar.');
        break;
      }
      const next = page.locator('.ui-datepicker-next:not(.ui-state-disabled)').first();
      if ((await next.count()) === 0) break;
      await next.click();
      await page.waitForTimeout(900);
    }

    if (found.length > 0) {
      const lines = found
        .map((f) => `• <b>día ${f.day}</b> — ${f.month} (${f.slots} hueco${f.slots === 1 ? '' : 's'})`)
        .join('\n');
      const message = [
        '🎉 <b>¡Hay citas de Jura de Nacionalidad!</b>',
        '',
        `<b>Oficina:</b> ${OFFICE}`,
        `<b>Trámite:</b> ${TRAMITE}`,
        '',
        lines,
        '',
        URL,
      ].join('\n');
      await notifyTelegram(message);
    } else if (FORCE_NOTIFY) {
      // TEMP: verify Telegram + scraping pipeline end-to-end.
      const summary = monthsScanned
        .map((m) => `• ${m.title ?? '?'}: ${m.clickable.length} días clicables`)
        .join('\n');
      const message = [
        '🧪 <b>Test checker Jura Nacionalidad</b>',
        'No hay huecos disponibles ahora mismo, pero el checker se ejecutó correctamente.',
        '',
        `<b>Oficina:</b> ${OFFICE}`,
        `<b>Trámite:</b> ${TRAMITE}`,
        `<b>Meses escaneados:</b> ${monthsScanned.length}`,
        '',
        summary || '(sin datos de calendario)',
        '',
        URL,
      ].join('\n');
      await notifyTelegram(message);
    } else {
      log('No available slots in the scanned range.');
    }

    const finishedAt = new Date().toISOString();
    return { startedAt, finishedAt, found, monthsScanned };
  } catch (err) {
    await saveDebug(page, 'error');
    throw err;
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCheck().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
