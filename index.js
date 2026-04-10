import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
// override: true — shell vars (even empty) no longer block values from .env
const dotenvResult = dotenv.config({ path: envPath, override: true });
if (dotenvResult.error?.code === "ENOENT") {
  console.warn(
    `[TicketsResale] No .env at ${envPath} — create it (see .env.example) or export TELEGRAM_* in the shell.`,
  );
}

const eventUrl = process.argv[2];
if (!eventUrl || !eventUrl.startsWith("http")) {
  console.error(
    "Usage: node index.js <ticketmaster-event-url>\n" +
      "Dry run (no Telegram): DRY_RUN=1 node index.js <url>\n" +
      "Dump full HTML: VERBOSE_HTML=1 node index.js <url>\n" +
      "Extra resale markers: TICKETSRESALE_RESALE_MARKERS=foo,bar node index.js <url>\n" +
      "Looser JSON/copy match (noisier): TICKETSRESALE_LOOSE_RESALE=1 node index.js <url>\n" +
      "Live alert (no DRY_RUN): npm run alert -- <url>  (needs TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in .env; multiple chats: id1,id2)\n" +
      "If Chrome is missing: npm run browsers   (or set PUPPETEER_EXECUTABLE_PATH to your Chrome/Chromium binary)",
  );
  process.exit(1);
}

/** Reduce SSRF / open-proxy risk: only https on Ticketmaster hosts you use. */
function assertSafeTicketmasterEventUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    console.error("Invalid event URL.");
    process.exit(1);
  }
  if (u.protocol !== "https:") {
    console.error("Only https:// event URLs are allowed.");
    process.exit(1);
  }
  if (u.username || u.password) {
    console.error("URL must not contain credentials.");
    process.exit(1);
  }
  const host = u.hostname.toLowerCase();
  const ok =
    host === "ticketmaster.com" ||
    host.endsWith(".ticketmaster.com") ||
    host === "ticketmaster.ie" ||
    host.endsWith(".ticketmaster.ie") ||
    host === "ticketmaster.co.uk" ||
    host.endsWith(".ticketmaster.co.uk");
  if (!ok) {
    console.error(
      "Host must be ticketmaster.com, ticketmaster.ie, or ticketmaster.co.uk (incl. www).",
    );
    process.exit(1);
  }
}

assertSafeTicketmasterEventUrl(eventUrl);

function buildResaleAlertBody() {
  const slug = eventUrl.split("/")[3] ?? "event";
  const text = `TicketsResale — resale may be available for "${slug}": ${eventUrl}`;
  return text.replace(/[\r\n\u0000]+/g, " ").trim().slice(0, 4096);
}

const dryRun = process.env.DRY_RUN === "1";

/** One-line status lines so a run is easy to scan in the terminal. */
function say(msg) {
  console.log("[TicketsResale] " + msg);
}

puppeteer.use(StealthPlugin());

function stripTelegramEnv(s) {
  if (s == null) return "";
  let t = String(s).replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Comma-separated chat ids; order preserved, duplicates removed. */
function parseTelegramChatIds(raw) {
  const stripped = stripTelegramEnv(raw);
  if (!stripped) return [];
  const ids = [];
  const seen = new Set();
  for (const part of stripped.split(",")) {
    const id = stripTelegramEnv(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function telegramErrorHint(data, res) {
  const desc = String(data.description || res.statusText || "request failed");
  let hint = "";
  if (data.error_code === 401) hint = " (check TELEGRAM_BOT_TOKEN)";
  if (data.error_code === 400 && /chat not found/i.test(desc))
    hint =
      " Run: npm run telegram:ping — each person must open YOUR bot and send /start; use their chat id (comma-separated for several).";
  if (data.error_code === 403)
    hint = " (you may have blocked the bot — unblock and send /start)";
  return desc + hint;
}

/**
 * Telegram Bot API (@BotFather token + your chat id). https://core.telegram.org/bots/api#sendmessage
 */
async function sendTelegramMessage(text) {
  const token = stripTelegramEnv(process.env.TELEGRAM_BOT_TOKEN);
  const chatIds = parseTelegramChatIds(process.env.TELEGRAM_CHAT_ID);
  if (!token || chatIds.length === 0) {
    const exists = fs.existsSync(envPath);
    const detail = exists
      ? `${envPath} exists but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing/blank.`
      : `Create ${envPath} (copy .env.example).`;
    throw new Error(
      `Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. ${detail} See https://core.telegram.org/bots/tutorial`,
    );
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const bodyBase = {
    text: text.slice(0, 4096),
    disable_web_page_preview: true,
  };
  const failures = [];
  for (const chat_id of chatIds) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...bodyBase, chat_id }),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    if (!data.ok) failures.push(`${chat_id}: ${telegramErrorHint(data, res)}`);
  }
  if (failures.length)
    throw new Error(`Telegram API: ${failures.join(" | ")}`);
}

const verboseHtml = process.env.VERBOSE_HTML === "1";
const looseResale = process.env.TICKETSRESALE_LOOSE_RESALE === "1";

/** DOM / a11y signals for an actual resale row (not minified bundle noise). */
function hasStrongResaleSignal(html) {
  if (html.includes("edp-quantity-filter-button")) return true;
  if (/aria-label="[^"]*Select\s+Resale\s+Tickets/i.test(html)) return true;
  return false;
}

/**
 * Heuristic JSON / copy — often appears in JS chunks on every event page → false alerts if used alone.
 */
function hasLooseResaleHint(html) {
  if (html.includes("Verified Resale Ticket")) return true;
  if (/"resaleListingId"\s*:\s*"[a-zA-Z0-9]{4,}"/.test(html)) return true;
  if (/"offerType"\s*:\s*"RESALE"/i.test(html)) return true;
  if (/"ticketType"\s*:\s*"(RESALE|resale)"/.test(html)) return true;
  if (
    /"inventoryType"\s*:\s*"resale"/i.test(html) &&
    /"available"\s*:\s*true/i.test(html)
  ) {
    return true;
  }
  return false;
}

/**
 * What we treat as “resale visible” for alerting and polling. Strong signals only unless
 * TICKETSRESALE_LOOSE_RESALE=1 or TICKETSRESALE_RESALE_MARKERS adds substrings.
 */
function hasResaleInventorySignal(html) {
  if (hasStrongResaleSignal(html)) return true;
  if (looseResale && hasLooseResaleHint(html)) return true;
  const extra =
    process.env.TICKETSRESALE_RESALE_MARKERS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  for (const sub of extra) {
    if (html.includes(sub)) return true;
  }
  return false;
}

/**
 * Only the real interstitial — not background scripts (e.g. iamNotaRobot.js) that can exist on normal pages.
 * Returns a short reason string for logs, or null if this does not look like the verify gate.
 */
function botChallengeReason(html) {
  if (/<abuse-component[^>]*\baction=["']identify["']/i.test(html)) {
    return "abuse-component (identity gate)";
  }
  if (
    html.includes("identify-spinner") &&
    html.includes("epsf.ticketmaster.com") &&
    !hasStrongResaleSignal(html)
  ) {
    return "verify shell (epsf + spinner, no ticket UI yet)";
  }
  return null;
}

function isBotChallenge(html) {
  return botChallengeReason(html) !== null;
}

/**
 * One snapshot can lose challenge markers mid-navigation. Only treat as "past the check"
 * when we see several stable snapshots, or a strong resale row (not loose JSON/i18n).
 */
function isPastBotChallengeSnapshot(html) {
  if (hasStrongResaleSignal(html)) return true;
  if (isBotChallenge(html)) return false;
  return html.length > 8000 && /ticketmaster/i.test(html);
}

async function waitUntilPastBotChallenge(page, label) {
  const pollMs = 2500;
  const needStable = 3;
  const maxWaitMs = 2 * 60 * 60 * 1000;
  let stable = 0;
  let html = "";
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await delay(pollMs);
    html = await safePageContent(page);
    if (isPastBotChallengeSnapshot(html)) {
      stable++;
      if (stable >= needStable) return html;
    } else {
      stable = 0;
    }
  }
  throw new Error(
    `${label}: timed out waiting for the page after the bot check (2h).`,
  );
}

async function delay(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * After navigations (e.g. TM bot check), page.content() can throw until the new document is ready.
 */
async function safePageContent(page, { attempts = 12, gapMs = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.content();
    } catch (e) {
      lastErr = e;
      const msg = e?.message ?? "";
      if (
        msg.includes("Execution context was destroyed") ||
        msg.includes("Target closed")
      ) {
        await delay(gapMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function sendResaleAlert(body) {
  if (dryRun) {
    say("DRY RUN — would send Telegram: " + body);
    return;
  }
  await sendTelegramMessage(body);
  say("Telegram notification delivered.");
}

const getAlerts = async () => {
  const chromePath =
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROME_PATH?.trim();
  const browser = await puppeteer.launch({
    headless: false,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: [
      // Bundled Chromium often fails with "No usable sandbox" on some Linux kernels/setups
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // if you want to work with proxies
      // '--incognito',
      // '--proxy-server=127.0.0.1:9876'
    ],
  });
  let page = await browser.newPage();
  // await page.setJavaScriptEnabled(false)
  let pages = await browser.pages();
  const oldPage = pages[0];
  await oldPage.close();

  await page.goto(eventUrl, {
    waitUntil: "domcontentloaded",
    timeout: 0,
  });
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 60_000 });
  } catch {
    // TM keeps long-polling; continue once DOM is usable
  }

  let html = await safePageContent(page);
  if (verboseHtml) console.log(html);
  else {
    const phase = isBotChallenge(html)
      ? `verify gate · ${botChallengeReason(html)}`
      : "event page (first paint)";
    say(`Loaded ${phase} · HTML ~${html.length} chars`);
  }

  if (isBotChallenge(html)) {
    say(
      `Verify step active (${botChallengeReason(html)}) at ${page.url()} — solve any captcha/checkbox in the browser window; do not reload.`,
    );
    html = await waitUntilPastBotChallenge(page, "Initial load");
    say("Verify step finished — page stable; checking for resale tickets…");
    if (verboseHtml) console.log(html);
  }

  // Legacy interstitial: "snag" copy also appears inside <noscript> on the challenge page — do not reload if challenge UI was present.
  while (
    html.includes("Your browser hit a snag") &&
    !hasStrongResaleSignal(html) &&
    !isBotChallenge(html)
  ) {
    await delay(5000);
    await page.reload({ waitUntil: "domcontentloaded" });
    html = await safePageContent(page);
    if (verboseHtml) console.log(html);
  }

  if (!hasResaleInventorySignal(html)) {
    say(
      "No resale UI on this HTML yet — watching (polls page for 15s, then reload). Ctrl+C to stop.",
    );

    let watchRound = 0;
    while (!hasResaleInventorySignal(html)) {
      watchRound += 1;
      say(`Watch round ${watchRound}: scanning for resale for up to 15s…`);

      const msToRun = 15000;
      const t0 = performance.now();
      let windowDone = false;
      while (!windowDone) {
        html = await safePageContent(page);
        if (isBotChallenge(html)) {
          say(
            `Verify step again (${botChallengeReason(html)}) — complete it in the browser; waiting until stable…`,
          );
          html = await waitUntilPastBotChallenge(page, "During watch");
          say("Back from verify step — resuming resale scan…");
        }
        if (hasResaleInventorySignal(html)) {
          say("Resale inventory detected — sending Telegram…");
          await sendResaleAlert(buildResaleAlertBody());
          await browser.close();
          return true;
        }
        if (performance.now() - t0 >= msToRun) windowDone = true;
      }

      say(
        `Watch round ${watchRound}: no resale in the last 15s — reloading the event page…`,
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      html = await safePageContent(page);
      while (
        html.includes("Your browser hit a snag") &&
        !hasStrongResaleSignal(html) &&
        !isBotChallenge(html)
      ) {
        await delay(5000);
        await page.reload({ waitUntil: "domcontentloaded" });
        html = await safePageContent(page);
        if (verboseHtml) console.log(html);
      }
      if (verboseHtml) console.log(html);
      else {
        const tail = isBotChallenge(html)
          ? `verify gate · ${botChallengeReason(html)}`
          : "ready for next scan";
        say(
          `Watch round ${watchRound}: after reload · ${tail} · HTML ~${html.length} chars`,
        );
      }
    }
  }
  if (hasResaleInventorySignal(html)) {
    say("Resale inventory detected — sending Telegram…");
    await sendResaleAlert(buildResaleAlertBody());
    await browser.close();
    return true;
  }
};

// Start the scraping
getAlerts()
  .then((r) => {
    if (r) say("All set — browser closed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
