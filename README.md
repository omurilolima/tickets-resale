# TicketsResale

Small **Node.js** watcher: open a **Ticketmaster** event URL in a real browser, poll the page, and send a **Telegram** message when **resale** inventory appears (for example “Verified Resale” / resale ticket UI).

**Unofficial tool.** Not affiliated with Ticketmaster. Use responsibly and respect their terms and rate limits. **Free and open source** ([MIT](LICENSE)) — fork and share welcome. Built as a personal / learning side project.

## Features

- **Telegram alerts** — Bot API with native `fetch`; `npm run telegram:ping` to verify token and chat id(s).
- **Dry run** — `DRY_RUN=1` or `npm run alert:dry` runs the browser flow without sending a message.
- **Multiple recipients** — Comma-separated Telegram chat ids; helpful errors for bad token, missing `/start`, or blocked bot.
- **URL allowlist** — Only `https` Ticketmaster hosts (`.com` / `.ie` / `.co.uk`), no credentials in the URL.
- **Resale detection** — Strong signals (real ticket UI / a11y) by default; optional looser JSON/copy mode and custom substring markers via env.
- **Verify / “snag” handling** — Waits through common Ticketmaster gates when possible before treating the page as ready.
- **Stack** — ES modules, Puppeteer with stealth plugin, `postinstall` Chrome install, optional `PUPPETEER_EXECUTABLE_PATH`.
- **Scripts** — `alert`, `alert:dry`, `telegram:ping`, `browsers`; `.env.example` for Telegram-focused config.

## Prerequisites

- **Node.js 18+** (uses native `fetch`)
- **Telegram bot** — [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **token**
- **Chat id(s)** — numeric Telegram user or group id (not your phone number). [@userinfobot](https://t.me/userinfobot) or [@RawDataBot](https://t.me/RawDataBot) after `/start`. Everyone who should get alerts must open **your** bot and send **`/start`** once.

## Quick start

```bash
git clone https://github.com/omurilolima/tickets-resale.git
cd tickets-resale
cp .env.example .env
```

Edit `.env`: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

```bash
npm install
npm run telegram:ping   # optional: confirm Telegram works
npm run alert -- "https://www.ticketmaster.ie/…/event/…"
```

The script opens **Chrome/Chromium** (non-headless) so you can pass Ticketmaster’s checks if they appear. Leave the window open while it runs.

If install complains about Chrome:

```bash
npm run browsers
# or set PUPPETEER_EXECUTABLE_PATH to your Chrome/Chromium binary (see .env.example)
```

## Commands

| Command                          | Purpose                                    |
| -------------------------------- | ------------------------------------------ |
| `npm run alert -- "<event-url>"` | Live run: Telegram when resale is detected |
| `npm run alert:dry -- "<url>"`   | Same flow, no Telegram (`DRY_RUN`)         |
| `npm run telegram:ping`          | Test token + chat id(s)                    |
| `npm run browsers`               | Install Puppeteer’s Chrome                 |

## Environment (`.env`)

| Variable                       | Required | Description                                                    |
| ------------------------------ | -------- | -------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`           | Yes\*    | Bot token from BotFather                                       |
| `TELEGRAM_CHAT_ID`             | Yes\*    | One id or comma-separated `id1,id2`                            |
| `PUPPETEER_EXECUTABLE_PATH`    | No       | Path to Chrome/Chromium if the bundled one fails               |
| `DRY_RUN`                      | No       | Set to `1` to skip Telegram (also via `npm run alert:dry`)     |
| `VERBOSE_HTML`                 | No       | `1` = dump HTML to the console (debug only)                    |
| `TICKETSRESALE_LOOSE_RESALE`   | No       | `1` = also match looser JSON/copy hints (more false positives) |
| `TICKETSRESALE_RESALE_MARKERS` | No       | Extra comma-separated substrings that count as a match         |

\*Not required for `alert:dry` if you only want to test the browser flow.

## How it works (short)

1. Loads `.env` from the project directory.
2. Opens the event URL with Puppeteer (+ stealth plugin), waits past common verify gates when possible.
3. Every **15 seconds** it re-reads the HTML; if no resale UI, it **reloads** the page and repeats.
4. When strong resale signals appear, it sends one Telegram message with the event link and exits.

## Disclaimer

Ticketmaster pages and bot protection change often. This project may break or need tuning. You are responsible for how you use it.

## Credits

Inspired by **[alertix](https://github.com/cozma/alertix)** ([Dag Yeshiwas / @cozma](https://github.com/cozma)). This version uses **Telegram** instead of **Twilio (SMS)** and is maintained here as a separate project.

## License

**Open source** — free to use, modify, and share. This project is released under the [MIT License](LICENSE): permissive, no cost, suitable for personal and commercial side projects alike.

## Enjoyed TicketsResale?

If this project helped you snag a ticket or saved you from endless refreshing, a **[star on GitHub](https://github.com/omurilolima/tickets-resale)** is genuinely appreciated — it helps others find the tool and means a lot for a small side project. Thank you.
