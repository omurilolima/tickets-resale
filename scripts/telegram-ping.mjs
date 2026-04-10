/**
 * Verifies .env Telegram settings and sends a test message.
 * If send fails, prints chat ids from getUpdates (after you message your bot /start).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), override: true });

function stripEnv(s) {
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

const token = stripEnv(process.env.TELEGRAM_BOT_TOKEN);

function parseChatIds(raw) {
  const stripped = stripEnv(raw);
  if (!stripped) return [];
  const ids = [];
  const seen = new Set();
  for (const part of stripped.split(",")) {
    const id = stripEnv(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const chatIds = parseChatIds(process.env.TELEGRAM_CHAT_ID);

async function main() {
  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
  }
  if (chatIds.length === 0) {
    console.error("Missing TELEGRAM_CHAT_ID in .env (use one id or id1,id2)");
    process.exit(1);
  }

  const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(
    (r) => r.json(),
  );
  if (!me.ok) {
    console.error("Invalid token (getMe):", me.description);
    process.exit(1);
  }
  console.log("Token OK, bot: @" + me.result.username);

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const failures = [];
  for (const chat_id of chatIds) {
    const send = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        text: "TicketsResale: Telegram test OK.",
        disable_web_page_preview: true,
      }),
    }).then((r) => r.json());
    if (send.ok) console.log("Test message sent to chat_id=" + chat_id);
    else failures.push({ chat_id, description: send.description });
  }

  if (failures.length === 0) return;

  for (const f of failures)
    console.error("sendMessage failed for " + f.chat_id + ":", f.description);

  const upd = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates`,
  ).then((r) => r.json());

  if (!upd.ok) {
    console.error("getUpdates failed:", upd.description);
    process.exit(1);
  }

  const ids = new Set();
  for (const u of upd.result ?? []) {
    const id =
      u.message?.chat?.id ??
      u.edited_message?.chat?.id ??
      u.channel_post?.chat?.id;
    if (id != null) ids.add(String(id));
  }

  console.error("\nDo this in Telegram:");
  console.error("  1) Open the bot you created with @BotFather (search its @username).");
  console.error("  2) Tap Start or send: /start");
  console.error("  3) Run: npm run telegram:ping again\n");

  if (ids.size) {
    console.error("Chat ids from your bot’s recent updates (use YOUR user id for DMs):");
    const line = [...ids].join(",");
    console.error("  TELEGRAM_CHAT_ID=" + line);
  } else {
    console.error(
      "No updates yet — the bot has never received a message from you.",
    );
  }

  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
