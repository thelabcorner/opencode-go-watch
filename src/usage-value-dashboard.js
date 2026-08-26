import { buildGoUsageYieldRanking, buildZenUsageYieldRanking } from "./usage-yield.js";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const COST = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

function esc(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}
function amount(value) { return typeof value === "number" && Number.isFinite(value) ? NUMBER.format(value) : "—"; }
function cost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.000001) return `$${value.toExponential(2)}`;
  return `$${COST.format(value)}`;
}
function percent(value) { return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "—"; }
function rank(entry) { return entry && Number.isFinite(entry.rank) ? `#${entry.rank}` : "—"; }
function bar(entry) {
  const width = typeof entry?.fractionOfBest === "number" && Number.isFinite(entry.fractionOfBest)
    ? Math.max(1.5, Math.min(100, entry.fractionOfBest * 100)) : 0;
  return `<div style="width:92px;height:5px;border-radius:999px;background:#1f1f23;overflow:hidden;margin-left:auto"><i style="display:block;width:${width.toFixed(1)}%;height:100%;background:#71717a"></i></div>`;
}
function confidence(entry) {
  const warning = entry?.warnings?.length ? ` · ${entry.warnings.length} warning${entry.warnings.length === 1 ? "" : "s"}` : "";
  return `${esc(entry?.confidence ?? "unknown")}${warning}`;
}
function band(entry, name) { return amount(entry?.workload?.[name]?.requestsPerDollar); }
function regime(entry) {
  if (entry?.regimes?.time) return `Off ${amount(entry.regimes.time.offPeakRequestsPerDollar)} / $ · Peak ${amount(entry.regimes.time.peakRequestsPerDollar)} / $`;
  const active = entry?.regimes?.context?.filter((item) => item.matchingWorkloads > 0) ?? [];
  if (active.length) return active.map((item) => `${esc(item.label)} · ${amount(item.requestsPerDollar)} / $`).join("<br>");
  return entry?.variantCount > 1 ? `${entry.variantCount} variants` : "Standard";
}
function calibrationSummary(ranking) {
  const stats = ranking?.calibration?.stats;
  if (!stats?.uniqueWorkloads) return "Waiting for a valid OpenCode Go workload calibration.";
  return `${stats.uniqueWorkloads} unique observed workload shapes · median context ${amount(stats.contextMedian)} tokens · P25 ${amount(stats.contextP25)} · P75 ${amount(stats.contextP75)}`;
}
function burstValue(entry) {
  const current = entry?.goCapacity?.currentFiveHourEquivalentRequests;
  const base = entry?.goCapacity?.baseFiveHourEquivalentRequests;
  const multiplier = entry?.goCapacity?.promotionMultiplier ?? 1;
  if (!(current > 0)) return "—";
  const rankText = Number.isFinite(entry.currentFiveHourRank) ? `#${entry.currentFiveHourRank}` : "—";
  return multiplier > 1
    ? `<strong>${amount(current)}</strong><div class="variant">${rankText} current · ${multiplier}x promo · base ${amount(base)}</div>`
    : `<strong>${amount(current)}</strong><div class="variant">${rankText} current 5h</div>`;
}

export function goUsageValueSection(snapshot) {
  if (!snapshot?.docs) return "";
  const ranking = buildGoUsageYieldRanking(snapshot);
  const paid = ranking.paidEntries ?? [];
  const best = paid[0] ?? null;
  const quotaExempt = ranking.quotaExemptEntries ?? [];
  const otherFree = (ranking.freeEntries ?? []).filter((entry) => entry.class !== "quota-exempt");
  const unranked = ranking.unrankedEntries ?? [];
  const rows = paid.map((entry) => `<tr>
    <td data-label="Rank" class="num mono"><strong>${rank(entry)}</strong></td>
    <td data-label="Model"><strong>${esc(entry.name)}</strong>${entry.tieCount > 1 ? ` <span class="pill">${entry.tieCount}-way tie</span>` : ""}</td>
    <td data-label="Go monthly work" class="num mono"><strong>${amount(entry.goCapacity?.monthlyEquivalentRequests)}</strong><div class="variant">standardized req</div></td>
    <td data-label="Current 5h work" class="num mono">${burstValue(entry)}</td>
    <td data-label="Req / $" class="num mono">${amount(entry.requestsPerDollar)}</td>
    <td data-label="Cost / request" class="num mono">${cost(entry.costPerEquivalentRequest)}</td>
    <td data-label="Relative value" class="num mono">${percent(entry.fractionOfBest)}${bar(entry)}</td>
    <td data-label="Light / Typical / Heavy" class="mono">${band(entry, "light")} / ${band(entry, "typical")} / ${band(entry, "heavy")} req/$</td>
    <td data-label="Pricing regime" class="window">${regime(entry)}</td>
    <td data-label="Confidence" class="window">${confidence(entry)}</td>
  </tr>`).join("");

  return `<section class="section wrap" id="usage-value"><div class="head"><div><div class="kick">Usage Yield V2</div><h2>Most coding-agent usage for the Go subscription</h2><p>Paid models are normalized against the same observed OpenCode agent workload corpus, then ranked by standardized work available through each model's effective Go allowance. Current 5-hour promotions are ranked separately and never silently inferred into monthly capacity.</p></div></div><div class="surface"><div class="surface-title"><strong>Usage value leaderboard</strong><span>${esc(calibrationSummary(ranking))}</span></div><div style="padding:12px 14px;border-bottom:1px solid #1c1c20;color:#71717a;font-size:9px;line-height:1.55">${best ? `Best paid monthly value: <strong style="color:#d4d4d8">${esc(best.name)}</strong> · ${amount(best.goCapacity?.monthlyEquivalentRequests)} standardized monthly requests · ${amount(best.requestsPerDollar)} req/$` : "No paid model currently has complete V2 evidence."}${quotaExempt.length ? ` · ${quotaExempt.length} Go quota-exempt model${quotaExempt.length === 1 ? "" : "s"} tracked separately` : ""}${otherFree.length ? ` · ${otherFree.length} finite free model${otherFree.length === 1 ? "" : "s"} tracked by published capacity` : ""}${unranked.length ? ` · ${unranked.length} unranked for incomplete/ambiguous evidence` : ""}</div><div class="tablewrap"><table class="table"><thead><tr><th class="num">Rank</th><th>Model</th><th class="num">Go monthly work</th><th class="num">Current 5h work</th><th class="num">Req / $</th><th class="num">$/standard request</th><th class="num">Vs best</th><th>Light / typical / heavy</th><th>Regime</th><th>Confidence</th></tr></thead><tbody>${rows || '<tr><td colspan="10">No ranked paid models.</td></tr>'}</tbody></table></div><div class="footerline"><span>Free ≠ unlimited. Quota-exempt and finite-free states are not mixed into paid division-by-dollar ranking.</span><span>Rank recomputes on price, model, regime, promotion, or workload-corpus changes.</span></div></div></section>`;
}

export function zenUsageValueSection(snapshot, goCalibrationSource) {
  if (!snapshot?.models) return "";
  const ranking = buildZenUsageYieldRanking(snapshot, goCalibrationSource);
  const paid = ranking.paidEntries ?? [];
  const free = ranking.freeEntries ?? [];
  const unranked = ranking.unrankedEntries ?? [];
  const best = paid[0] ?? null;
  const rows = paid.map((entry) => `<tr>
    <td data-label="Rank" class="mono"><strong>${rank(entry)}</strong></td>
    <td data-label="Model"><strong>${esc(entry.name)}</strong></td>
    <td data-label="Equivalent req / $" class="mono"><strong>${amount(entry.requestsPerDollar)}</strong></td>
    <td data-label="Cost / request" class="mono">${cost(entry.costPerEquivalentRequest)}</td>
    <td data-label="Relative value" class="mono">${percent(entry.fractionOfBest)}${bar(entry)}</td>
    <td data-label="Light / Typical / Heavy" class="mono">${band(entry, "light")} / ${band(entry, "typical")} / ${band(entry, "heavy")}</td>
    <td data-label="Pricing regime" class="endpoint">${regime(entry)}</td>
    <td data-label="Confidence" class="endpoint">${confidence(entry)}</td>
  </tr>`).join("");

  return `<section class="section wrap" id="usage-value"><div class="head"><div><div class="kick">Usage Yield V2</div><h2>Paid Zen usage value</h2><p>Every paid Zen model is priced against the same OpenCode Go coding-agent workload corpus. Higher equivalent requests per dollar means more comparable agent work for the money.</p></div></div><div class="surface"><div class="surface-title"><strong>Paid usage-value leaderboard</strong><span>${esc(calibrationSummary(ranking))}</span></div><div style="padding:12px 14px;border-bottom:1px solid #1d1d21;color:#71717a;font-size:8px;line-height:1.55">${best ? `Best paid value: <strong style="color:#d4d4d8">${esc(best.name)}</strong> · ${amount(best.requestsPerDollar)} equivalent agent requests / $1` : "No paid model currently has complete V2 evidence."} · ${free.length} free model${free.length === 1 ? "" : "s"} kept outside paid ranking because public comparable capacity is unknown${unranked.length ? ` · ${unranked.length} paid model${unranked.length === 1 ? "" : "s"} unranked for incomplete/ambiguous evidence` : ""}</div><div class="tablewrap"><table class="table"><thead><tr><th>Rank</th><th>Model</th><th>Equivalent req / $</th><th>$/standard request</th><th>Vs best</th><th>Light / typical / heavy req/$</th><th>Regime</th><th>Confidence</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No ranked paid models.</td></tr>'}</tbody></table></div></div></section>`;
}
