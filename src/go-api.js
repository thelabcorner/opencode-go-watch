function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function firstDifference(before, after, radius = 140) {
  const a = String(before ?? "");
  const b = String(after ?? "");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const start = Math.max(0, i - radius);
  return {
    before: a.slice(start, Math.min(a.length, i + radius)) || "",
    after: b.slice(start, Math.min(b.length, i + radius)) || "",
  };
}

function semanticModel(item) {
  return {
    id: item.id.trim(),
    object: typeof item.object === "string" ? item.object : null,
    ownedBy: typeof item.owned_by === "string" ? item.owned_by : null,
  };
}

function modelExtras(item) {
  const extras = {};
  for (const [key, value] of Object.entries(item)) {
    // OpenCode's models handler intentionally stamps `created` with Date.now() on
    // every request. It is transport noise, not a model-catalog transition.
    if (["id", "object", "created", "owned_by"].includes(key)) continue;
    extras[key] = stableValue(value);
  }
  return extras;
}

export function parseGoModelsApi(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    throw new Error("Go models API returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) {
    throw new Error("Go models API response is missing data[]");
  }
  if (parsed.object != null && parsed.object !== "list") {
    throw new Error(`Go models API returned unexpected object type ${JSON.stringify(parsed.object)}`);
  }

  const malformed = parsed.data.filter((item) => !item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim());
  if (malformed.length) throw new Error(`Go models API returned ${malformed.length} malformed model entr${malformed.length === 1 ? "y" : "ies"}`);

  const models = parsed.data.map(semanticModel).sort((a, b) => a.id.localeCompare(b.id));
  const modelIds = models.map((model) => model.id);
  if (new Set(modelIds).size !== modelIds.length) throw new Error("Go models API returned duplicate model IDs");

  const perModelExtras = parsed.data
    .map((item) => [item.id.trim(), modelExtras(item)])
    .filter(([, extras]) => Object.keys(extras).length)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const envelopeExtras = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "object" || key === "data") continue;
    envelopeExtras[key] = stableValue(value);
  }
  const monitorStructure = stableJson({ envelope: envelopeExtras, models: perModelExtras });
  return { object: parsed.object ?? null, models, modelIds, monitorStructure };
}

export function prepareGoModelsApi(text) {
  const api = parseGoModelsApi(text);
  // Fingerprint the canonical semantic projection. This is deliberately not a hash
  // of the raw response because `created` changes on every OpenCode GET.
  return {
    api,
    fingerprintSource: stableJson({ models: api.models, monitorStructure: api.monitorStructure }),
  };
}

function modelMap(api) {
  return new Map((api?.models ?? []).map((model) => [model.id, model]));
}

export function diffGoModelsApi(beforeApi, afterApi) {
  // Missing beforeApi is a schema/configuration migration. Seed the new catalog
  // silently rather than announcing the entire current catalog as newly launched.
  if (!beforeApi || !afterApi) return [];

  const changes = [];
  const before = modelMap(beforeApi);
  const after = modelMap(afterApi);
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    const oldModel = before.get(id);
    const newModel = after.get(id);
    if (!oldModel) {
      changes.push({ type: "go_api_model_added", key: id, after: newModel });
      continue;
    }
    if (!newModel) {
      changes.push({ type: "go_api_model_removed", key: id, before: oldModel });
      continue;
    }
    for (const field of ["object", "ownedBy"]) {
      const oldValue = oldModel[field] ?? null;
      const newValue = newModel[field] ?? null;
      if (oldValue !== newValue) changes.push({ type: "go_api_model_changed", key: id, field, before: oldValue, after: newValue });
    }
  }

  const knownChanged = changes.length > 0;
  if (!knownChanged && beforeApi.monitorStructure !== afterApi.monitorStructure) {
    changes.push({
      type: "go_api_unclassified_change",
      source: "go_api",
      ...firstDifference(beforeApi.monitorStructure, afterApi.monitorStructure),
    });
  }
  return changes;
}

export function isGoApiChange(change) {
  return String(change?.type ?? "").startsWith("go_api_");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(value) {
  if (value == null || value === "") return "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function checkedAt(snapshot, timeZone) {
  const date = new Date(snapshot?.checkedAt ?? Date.now());
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function apiHeadline(changes) {
  const types = new Set(changes.map((change) => change.type));
  if (types.has("go_api_unclassified_change")) return "🟡 <b>OPENCODE GO · API UNCLASSIFIED CHANGE</b>";
  if (types.has("go_api_model_removed")) return "🚫 <b>OPENCODE GO · API MODEL REMOVED</b>";
  if (types.has("go_api_model_added")) return "🛰️ <b>OPENCODE GO · API MODEL ADDED</b>";
  return "🧬 <b>OPENCODE GO · API MODEL METADATA CHANGED</b>";
}

export function buildGoApiChangeMessages(changes, snapshot, timeZone = "America/Chicago") {
  if (!changes?.length) return [];
  const lines = [];
  for (const change of changes) {
    if (change.type === "go_api_model_added") {
      lines.push(`➕ <code>opencode/${esc(change.key)}</code>${change.after?.ownedBy ? ` · ${esc(change.after.ownedBy)}` : ""}`);
    } else if (change.type === "go_api_model_removed") {
      lines.push(`➖ <code>opencode/${esc(change.key)}</code>${change.before?.ownedBy ? ` · ${esc(change.before.ownedBy)}` : ""}`);
    } else if (change.type === "go_api_model_changed") {
      lines.push(`🔁 <code>opencode/${esc(change.key)}</code> · ${esc(change.field)}: <code>${esc(fmt(change.before))} → ${esc(fmt(change.after))}</code>`);
    } else if (change.type === "go_api_unclassified_change") {
      lines.push(`Before  <code>${esc(change.before || "none")}</code>`);
      lines.push(`After   <code>${esc(change.after || "none")}</code>`);
    }
  }
  const catalogCount = snapshot?.api?.modelIds?.length ?? snapshot?.api?.models?.length ?? 0;
  const body = lines.slice(0, 24);
  if (lines.length > body.length) body.push(`…and ${lines.length - body.length} more`);
  return [
    `${apiHeadline(changes)}\n━━━━━━━━━━━━━━━━━━━━\n${body.join("\n")}\n\n📚 Catalog  <b>${catalogCount}</b> models\n🕒 ${esc(checkedAt(snapshot, timeZone))}`,
  ];
}
