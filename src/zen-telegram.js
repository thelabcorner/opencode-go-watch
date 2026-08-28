import { resolveTelegramChatId, watcherDashboardUrl } from "./telegram.js";
import { basePricingName, buildZenUsageYieldRanking, usageYieldFor } from "./usage-yield.js";

const MAX_MESSAGE = 3850;
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const YIELD = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COST = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
const TIME = new Map();

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function money(value) {
  return typeof value === "number" && Number.isFinite(value) ? (value === 0 ? "Free" : `$${NUMBER.format(value)}`) : "—";
}

function cost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.00000001) return `$${value.toExponential(2)}`;
  return `$${COST.format(value)}`;
}

function amount(value) {
  return typeof value === "number" && Number.isFinite(value) ? YIELD.format(value) : "—";
}

function pct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return `${value > 0 ? "+" : ""}${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)}%`;
}

function time(iso, zone) {
  try {
    let formatter = TIME.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
      TIME.set(zone, formatter);
    }
    return formatter.format(new Date(iso));
  } catch {
    return iso;
  }
}

function modelLine(model) {
  if (!model) return "";
  return [
    `<b>${esc(model.name ?? model.id)}</b>`,
    model.id ? `<code>opencode/${esc(model.id)}</code>` : "",
    model.endpoint ? `Endpoint  <code>${esc(model.endpoint.replace("https://opencode.ai/zen/v1", "…/zen/v1"))}</code>` : "",
  ].filter(Boolean).join("\n");
}

function priceLabel(field) {
  return ({ inputPerM: "Input", outputPerM: "Output", cachedReadPerM: "Cached read", cachedWritePerM: "Cached write" })[field] ?? field;
}

function paidRankLabel(entry) {
  const tie = entry.tieCount > 1 ? ` · ${entry.tieCount}-way tie` : "";
  return `#${entry.rank} of ${entry.total} paid${tie}`;
}

function zenUsageValueLine(ranking, model) {
  const name = typeof model === "string" ? model : model?.name ?? model?.id;
  const entry = usageYieldFor(ranking, name);
  if (!entry || entry.class === "unranked") {
    const reason = ranking?.calibration?.workloads?.length ? "pending complete published pricing" : "waiting for Go workload calibration";
    return `💸 <b>Usage value</b>  <i>${reason}</i>`;
  }
  if (entry.class === "free-limited-unknown") {
    return `💸 <b>Usage value</b>  <b>FREE</b>\n<i>Public Zen sources do not establish a comparable request-capacity limit, so V2 does not invent an “unlimited” yield.</i>`;
  }
  const best = typeof entry.fractionOfBest === "number" ? `${(entry.fractionOfBest * 100).toFixed(0)}% of best` : "";
  const lines = [
    `💸 <b>Usage value</b>  <code>${paidRankLabel(entry)}</code>`,
    `~<b>${amount(entry.requestsPerDollar)}</b> equivalent agent requests / $1 · ${best}`,
    `~${cost(entry.costPerEquivalentRequest)} / standardized request`,
  ];
  if (entry.regimes?.time) {
    lines.push(`<i>Off-peak ~${amount(entry.regimes.time.offPeakRequestsPerDollar)} req/$ · Peak ~${amount(entry.regimes.time.peakRequestsPerDollar)} req/$ · peak usage ${pct(entry.regimes.time.peakUsagePenaltyPercent)}</i>`);
  } else if (entry.variantCount > 1) {
    lines.push(`<i>${entry.variantCount} pricing variants are applied by workload/context semantics; rank is not based on the cheapest row.</i>`);
  }
  if (entry.confidence !== "high") lines.push(`<i>Evidence confidence: ${esc(entry.confidence)}</i>`);
  return lines.join("\n");
}

function calibrationLine(ranking) {
  const count = ranking?.calibration?.stats?.uniqueWorkloads;
  return count ? `<i>V2 prices every paid Zen model against the same ${count}-shape OpenCode Go agent workload corpus.</i>` : "";
}

function lifecycleBlocks(changes, ranking) {
  const blocks = [];
  const consumed = new Set();
  changes.forEach((change, index) => {
    if (!["zen_free_model_added", "zen_free_model_removed", "zen_model_added", "zen_model_removed"].includes(change.type)) return;
    consumed.add(index);
    const added = change.type.endsWith("added");
    const free = change.type.includes("free_model");
    const model = added ? change.after : change.before;
    const associated = [];
    changes.forEach((other, otherIndex) => {
      if (otherIndex === index || consumed.has(otherIndex)) return;
      if (other.key === change.key && ["zen_endpoint_added", "zen_endpoint_removed"].includes(other.type)) {
        consumed.add(otherIndex);
        associated.push(other);
      }
      if (model?.name && other.key && String(other.key).startsWith(model.name) && ["zen_pricing_row_added", "zen_pricing_row_removed"].includes(other.type)) {
        consumed.add(otherIndex);
        associated.push(other);
      }
    });
    const icon = free ? (added ? "🆓" : "🚫") : (added ? "🆕" : "🗑");
    const title = free ? (added ? "FREE MODEL ADDED" : "FREE MODEL REMOVED") : (added ? "ZEN MODEL ADDED" : "ZEN MODEL REMOVED");
    blocks.push([
      `${icon} <b>${title}</b>`,
      modelLine(model),
      added ? zenUsageValueLine(ranking, model) : "",
      added && !free ? calibrationLine(ranking) : "",
      free ? `<b>${added ? "Free access is now available" : "Free access was removed"}</b>` : "",
      associated.some((item) => item.type.includes("pricing")) ? `💰 ${added ? "Pricing row published" : "Pricing row removed"}` : "",
    ].filter(Boolean).join("\n"));
  });
  return { blocks, consumed };
}

function renderBlocks(changes, snapshot, calibrationSource) {
  const ranking = buildZenUsageYieldRanking(snapshot, calibrationSource);
  const { blocks, consumed } = lifecycleBlocks(changes, ranking);
  const priceGroups = new Map();
  changes.forEach((change, index) => {
    if (consumed.has(index) || change.type !== "zen_price_changed") return;
    if (!priceGroups.has(change.key)) priceGroups.set(change.key, []);
    priceGroups.get(change.key).push({ ...change, __index: index });
  });
  for (const [row, group] of priceGroups) {
    group.forEach((item) => consumed.add(item.__index));
    const discount = group.some((item) => typeof item.before === "number" && typeof item.after === "number" && item.after < item.before);
    blocks.push(`${discount ? "🏷️" : "💰"} <b>${discount ? "ZEN PRICE DROP" : "ZEN PRICING CHANGED"}</b>\n<b>${esc(row)}</b>\n${zenUsageValueLine(ranking, basePricingName(row))}\n${group.map((item) => `${priceLabel(item.field)}: <code>${money(item.before)} → ${money(item.after)}</code>${item.percent == null ? "" : `  ${item.after < item.before ? "▼" : "▲"} ${pct(item.percent)}`}`).join("\n")}`);
  }

  changes.forEach((change, index) => {
    if (consumed.has(index)) return;
    consumed.add(index);
    switch (change.type) {
      case "zen_model_became_free":
        blocks.push(`🆓 <b>MODEL BECAME FREE</b>\n${modelLine(change.after)}\n${zenUsageValueLine(ranking, change.after)}\n<b>Paid → Free</b>`);
        break;
      case "zen_model_no_longer_free":
        blocks.push(`💳 <b>MODEL NO LONGER FREE</b>\n${modelLine(change.after ?? change.before)}\n${zenUsageValueLine(ranking, change.after ?? change.before)}\n<b>Free → Paid</b>`);
        break;
      case "zen_pricing_row_added":
        blocks.push(`💰 <b>ZEN PRICING ROW ADDED</b>\n<b>${esc(change.key)}</b>\n${zenUsageValueLine(ranking, basePricingName(change.key))}\n<code>in ${money(change.after?.inputPerM)} · out ${money(change.after?.outputPerM)} · cache ${money(change.after?.cachedReadPerM)}</code>`);
        break;
      case "zen_pricing_row_removed":
        blocks.push(`🧹 <b>ZEN PRICING ROW REMOVED</b>\n<b>${esc(change.key)}</b>\n${zenUsageValueLine(ranking, basePricingName(change.key))}`);
        break;
      case "zen_endpoint_added":
        blocks.push(`🔌 <b>ZEN ENDPOINT ADDED</b>\n${modelLine(change.after)}`);
        break;
      case "zen_endpoint_removed":
        blocks.push(`🔌 <b>ZEN ENDPOINT REMOVED</b>\n${modelLine(change.before)}`);
        break;
      case "zen_endpoint_changed":
        blocks.push(`🔌 <b>ZEN ENDPOINT CHANGED</b>\n<code>${esc(change.key)}</code>\n${esc(change.field)}: <code>${esc(change.before ?? "none")} → ${esc(change.after ?? "none")}</code>`);
        break;
      case "zen_deprecation_added":
        blocks.push(`🗓️ <b>ZEN DEPRECATION ADDED</b>\n<b>${esc(change.key)}</b>\n<code>${esc(change.after)}</code>`);
        break;
      case "zen_deprecation_removed":
        blocks.push(`✅ <b>ZEN DEPRECATION REMOVED</b>\n<b>${esc(change.key)}</b>`);
        break;
      case "zen_deprecation_changed":
        blocks.push(`🗓️ <b>ZEN DEPRECATION DATE CHANGED</b>\n<b>${esc(change.key)}</b>\n<code>${esc(change.before)} → ${esc(change.after)}</code>`);
        break;
      case "zen_note_changed":
        blocks.push(`📝 <b>ZEN POLICY / NOTE CHANGED</b>\n<b>${esc(change.key)}</b>\n<code>${esc(change.before ?? "none")}</code>\n↓\n<code>${esc(change.after ?? "none")}</code>`);
        break;
      case "zen_free_note_changed":
        blocks.push(`🆓 <b>FREE MODEL NOTE CHANGED</b>\n<code>${esc(change.key)}</code>\n<code>${esc(change.before ?? "none")}</code>\n↓\n<code>${esc(change.after ?? "none")}</code>`);
        break;
      case "zen_offer_added":
        blocks.push(`🏷️ <b>ZEN OFFER / DISCOUNT ADDED</b>\n${esc(change.after)}`);
        break;
      case "zen_offer_removed":
        blocks.push(`🏷️ <b>ZEN OFFER / DISCOUNT REMOVED</b>\n${esc(change.before)}`);
        break;
      case "zen_model_owner_changed":
        blocks.push(`🏢 <b>ZEN MODEL OWNER CHANGED</b>\n<code>${esc(change.key)}</code>\n<code>${esc(change.before ?? "none")} → ${esc(change.after ?? "none")}</code>`);
        break;
      case "zen_consistency_changed":
        blocks.push(`⚠️ <b>ZEN DOCS / API COVERAGE CHANGED</b>\n<b>${esc(change.key)}</b>\n<code>${esc(JSON.stringify(change.before))}</code>\n↓\n<code>${esc(JSON.stringify(change.after))}</code>`);
        break;
      case "zen_unclassified_docs_change":
      case "zen_unclassified_api_change":
        blocks.push(`🟡 <b>UNCLASSIFIED ZEN CHANGE</b>\n<b>${change.type.includes("docs") ? "Zen docs" : "Zen models API"}</b>\nThe monitored source changed, but known Zen semantic fields stayed the same.\n\n<b>Before</b> <code>${esc(change.before || "(nothing)")}</code>\n<b>After</b> <code>${esc(change.after || "(nothing)")}</code>`);
        break;
      default:
        blocks.push(`• <b>${esc(change.type)}</b>`);
    }
  });
  return blocks;
}

function headline(changes) {
  const types = new Set(changes.map((change) => change.type));
  if (types.has("zen_free_model_added")) return "🆓 <b>OPENCODE ZEN · NEW FREE MODEL</b>";
  if (types.has("zen_free_model_removed")) return "🚫 <b>OPENCODE ZEN · FREE MODEL REMOVED</b>";
  if (types.has("zen_model_became_free")) return "🆓 <b>OPENCODE ZEN · MODEL IS NOW FREE</b>";
  if (types.has("zen_model_no_longer_free")) return "💳 <b>OPENCODE ZEN · FREE ACCESS ENDED</b>";
  if (types.has("zen_offer_added")) return "🏷️ <b>OPENCODE ZEN · NEW OFFER / DISCOUNT</b>";
  if (changes.some((change) => change.type === "zen_price_changed" && typeof change.before === "number" && typeof change.after === "number" && change.after < change.before)) return "🏷️ <b>OPENCODE ZEN · PRICE DROP</b>";
  if (types.has("zen_model_added")) return "🆕 <b>OPENCODE ZEN · MODEL ADDED</b>";
  if (types.has("zen_model_removed")) return "🗑 <b>OPENCODE ZEN · MODEL REMOVED</b>";
  if ([...types].some((type) => type.includes("price") || type.includes("pricing"))) return "💰 <b>OPENCODE ZEN · PRICING UPDATE</b>";
  if ([...types].some((type) => type.includes("unclassified"))) return "🟡 <b>OPENCODE ZEN · UNCLASSIFIED CHANGE</b>";
  return "🟣 <b>OPENCODE ZEN WATCH</b>";
}

export function buildZenChangeMessages(changes, snapshot, timeZone = "America/Chicago", calibrationSource = null) {
  const blocks = renderBlocks(changes, snapshot, calibrationSource);
  const header = `${headline(changes)}\n━━━━━━━━━━━━━━━━━━━━\n<b>${changes.length}</b> semantic field change${changes.length === 1 ? "" : "s"} · <b>${blocks.length}</b> update card${blocks.length === 1 ? "" : "s"}`;
  const footer = `\n\n🕒 ${esc(time(snapshot.checkedAt, timeZone))}\n🔎 Zen models API + Zen docs`;
  const out = [];
  let current = header;
  for (const block of blocks) {
    if (`${current}\n\n${block}${footer}`.length > MAX_MESSAGE && current !== header) {
      out.push(`${current}${footer}`);
      current = `↪️ <b>OPENCODE ZEN WATCH · continued</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${block}`;
    } else current += `\n\n${block}`;
  }
  out.push(`${current}${footer}`);
  return out;
}

export function buildZenBootMessage(snapshot, timeZone = "America/Chicago") {
  const models = Object.values(snapshot.models ?? {});
  const free = models.filter((model) => model.free);
  const documented = models.filter((model) => model.documented).length;
  return [
    "🟣 <b>OPENCODE ZEN WATCH · ARMED</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "Zen availability and pricing monitoring is live.",
    "",
    `🧠 <b>${models.length}</b> API models · 📚 <b>${documented}</b> documented`,
    `🆓 <b>${free.length}</b> currently free`,
    free.length ? free.slice(0, 10).map((model) => `• ${esc(model.name)}`).join("\n") : "",
    free.length > 10 ? `• …and ${free.length - 10} more` : "",
    "",
    `🕒 ${esc(time(snapshot.checkedAt, timeZone))}`,
  ].filter(Boolean).join("\n");
}

export function buildZenErrorMessage(error, checkedAt, timeZone = "America/Chicago") {
  return `🔴 <b>OPENCODE ZEN WATCH · ERROR</b>\n━━━━━━━━━━━━━━━━━━━━\nA Zen monitoring run failed. The previous known-good Zen baseline was preserved.\n\n<code>${esc(error?.message ?? String(error))}</code>\n\n🕒 ${esc(time(checkedAt, timeZone))}`;
}

export function buildZenRecoveryMessage(previousError, checkedAt, timeZone = "America/Chicago") {
  return `✅ <b>OPENCODE ZEN WATCH · RECOVERED</b>\n━━━━━━━━━━━━━━━━━━━━\nZen models API and documentation are parsing successfully again.\n\nLast error\n<code>${esc(previousError?.message ?? "unknown")}</code>\n\n🕒 ${esc(time(checkedAt, timeZone))}`;
}

export function zenKeyboard(env = {}) {
  const rows = [];
  const dashboard = watcherDashboardUrl(env, "/zen");
  if (dashboard) rows.push([{ text: "🛰 Zen Watcher Dashboard", url: dashboard }]);
  rows.push([
    { text: "🧠 Zen Models", url: "https://opencode.ai/docs/zen/#models" },
    { text: "💰 Zen Pricing", url: "https://opencode.ai/docs/zen/#pricing" },
  ]);
  return { inline_keyboard: rows };
}

export async function sendZenTelegram(env, html, fetchImpl = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN) return { skipped: true, reason: "telegram_bot_token_not_configured" };
  const chatId = await resolveTelegramChatId(env, fetchImpl);
  if (!chatId) return { skipped: true, reason: "telegram_chat_not_configured" };
  const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: zenKeyboard(env) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || !data?.ok) throw new Error(`Telegram sendMessage failed: ${data?.description ?? `HTTP ${response.status}`}`);
  return { skipped: false, chatIdSuffix: String(chatId).slice(-4) };
}
