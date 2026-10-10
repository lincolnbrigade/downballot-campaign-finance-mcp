#!/usr/bin/env node
/**
 * Re-verify the jurisdiction registry against the live publishers. No key needed.
 *
 *   node tests/verify-jurisdiction-sources.mjs
 *
 * For every entry in servers/jurisdiction/sources.json it checks that the
 * dataset still exists, that its publisher credit and title are unchanged, that
 * every column the connector selects, groups or filters on still exists, that
 * every column it sums is still a number, and that a one-row query still
 * answers. Prints column names and counts only, never row contents.
 *
 * A carto entry has no metadata record on the platform, so its publisher credit
 * and title are read from the catalogue record the entry names (catalog_record),
 * its columns from an empty query, and its enum filters are compared with the
 * values now in the data (category values such as office names, not rows).
 *
 * An arcgis entry is checked against the layer's own metadata (name, copyright
 * text, fields) and one totals query for the current year. Two things observed
 * on 2026-10-05 that this script allows for: paging is ignored on a statistics
 * query, and a failed query is an HTTP 200 with an error body.
 *
 * An ocpf entry (Massachusetts OCPF Public API) is checked against the API's
 * own description (title, description, contact, and that the path is still
 * listed) and one live answer for the current year. The path check matters:
 * observed 2026-10-05, a path that does not exist answers 200 with an empty
 * list, so an empty answer alone cannot tell a quiet year from a moved list.
 *
 * Run it before changing "verified_on", after any publisher error, and every
 * few months: open-data portals rename and retire datasets without notice.
 * Exit 1 means at least one entry needs attention.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(fs.readFileSync(path.join(here, "..", "servers", "jurisdiction", "sources.json"), "utf8"));
let bad = 0;
const say = (ok, msg) => {
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

// Carto: the SQL API at https://<domain>/api/v2/sql?q=...
const carto = async (s, sql) => {
  const r = await fetch(`https://${s.domain}/api/v2/sql?${new URLSearchParams({ q: sql })}`, { signal: AbortSignal.timeout(60000) });
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : null };
};

async function verifyCarto(s) {
  // 1. The credit and title, from the catalogue record (YAML front matter).
  try {
    const r = await fetch(s.catalog_record, { signal: AbortSignal.timeout(45000) });
    say(r.ok, `catalogue record answers (${r.status})`);
    if (r.ok) {
      const text = await r.text();
      const field = (name) => (text.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
      say(field("organization") === s.publisher, `publisher credit unchanged: "${field("organization") || "(none)"}"`);
      say(field("title") === s.dataset_name, `title unchanged: "${field("title").slice(0, 70)}"`);
      say(text.includes(`${s.domain}/api/v2/sql`) && text.includes(s.dataset), `catalogue record still points at ${s.dataset} on ${s.domain}`);
    }
  } catch (e) {
    say(false, `could not reach the catalogue record: ${e.message}`);
  }

  // 2. Columns and types, from a query that returns no rows.
  let fields;
  try {
    const r = await carto(s, `SELECT * FROM ${s.dataset} LIMIT 0`);
    say(r.ok, `table answers (${r.status})`);
    if (!r.ok) return;
    fields = r.body.fields;
  } catch (e) {
    say(false, `could not reach ${s.domain}: ${e.message}`);
    return;
  }
  const used = [...new Set([...s.select, ...Object.values(s.filters).map((f) => f.column), ...Object.keys(s.require_in || {}), ...(s.freshness_column ? [s.freshness_column] : [])])];
  const missing = used.filter((c) => !(c in fields));
  say(!missing.length, missing.length ? `columns gone: ${missing.join(", ")}` : `all ${used.length} columns still present`);
  const notNum = (s.numeric || []).filter((c) => fields[c]?.type !== "number");
  say(!notNum.length, notNum.length ? `not numeric any more: ${notNum.map((c) => `${c}:${fields[c]?.type}`).join(", ")}` : "numeric columns are numeric");
  if (missing.length) return;

  // 3. Enum filters: a value in the data that the registry lacks cannot be asked for.
  for (const [k, f] of Object.entries(s.filters).filter(([, f]) => f.type === "enum")) {
    try {
      const r = await carto(s, `SELECT DISTINCT ${f.column} AS v FROM ${s.dataset} WHERE ${f.column} IS NOT NULL`);
      const live = r.ok ? r.body.rows.map((x) => x.v) : [];
      const added = live.filter((v) => !f.values.includes(v) && !(f.excluded_values || []).includes(v));
      say(r.ok && !added.length, added.length ? `${k}: values in the data but not in the registry: ${added.join(", ")}` : `${k}: all ${live.length} values in the data are in the registry${f.excluded_values ? ` (${f.excluded_values.length} left out on purpose)` : ""}`);
      const unused = f.values.filter((v) => !live.includes(v));
      if (unused.length) console.log(`       ${k}: in the registry but not in the data now: ${unused.join(", ")}`);
    } catch (e) {
      say(false, `${k}: could not list values: ${e.message}`);
    }
  }

  // 4. One real query, built the way the connector builds it, with no filters.
  try {
    const where = Object.entries(s.require_in || {}).map(([c, values]) => `${c} IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`).join(" AND ");
    const r = await carto(s, `SELECT ${s.select.join(", ")} FROM ${s.dataset}${where ? ` WHERE ${where}` : ""} ORDER BY ${s.order_by} NULLS LAST LIMIT 1`);
    say(r.ok && r.body.rows.length === 1, `one-row query answers (${r.status}, ${r.ok ? r.body.rows.length : 0} row)`);
    if (s.freshness_column) {
      const f = await carto(s, `SELECT max(${s.freshness_column}) AS latest FROM ${s.dataset}`);
      const latest = f.ok ? f.body.rows[0]?.latest : null;
      say(Boolean(latest), `newest report date answers`);
      if (latest) console.log(`       newest report dated ${String(latest).slice(0, 10)}`);
    }
  } catch (e) {
    say(false, `query failed: ${e.message}`);
  }
}

async function verifyArcgis(s) {
  const layer = `https://${s.domain}${s.service_path}/${s.dataset}`;
  const get = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const body = r.ok ? await r.json() : null;
    return { ok: r.ok && !body?.error, status: body?.error ? `200 with error ${body.error.code}` : r.status, body };
  };
  let meta;
  try {
    const r = await get(`${layer}?f=json`);
    say(r.ok, `layer metadata answers (${r.status})`);
    if (!r.ok) return;
    meta = r.body;
  } catch (e) {
    say(false, `could not reach ${s.domain}: ${e.message}`);
    return;
  }
  say((meta.copyrightText || null) === (s.publisher ?? null), `publisher credit unchanged: "${meta.copyrightText || "(none)"}"`);
  say(meta.name === s.dataset_name, `title unchanged: "${String(meta.name).slice(0, 70)}"`);
  say(meta.supportsStatistics === true, "the layer still does totals on the server");

  const type = Object.fromEntries((meta.fields || []).map((f) => [f.name, f.type]));
  const used = [...new Set([...s.group_by, ...s.measures.map((m) => m.column).filter(Boolean), ...Object.values(s.filters).map((f) => f.column), s.count_field, s.freshness_column, s.newest_column].filter(Boolean))];
  const missing = used.filter((c) => !(c in type));
  say(!missing.length, missing.length ? `columns gone: ${missing.join(", ")}` : `all ${used.length} columns still present`);
  const notNum = s.measures.filter((m) => m.fn === "sum" && !/Integer|Double|Single/.test(type[m.column] || "")).map((m) => `${m.column}:${type[m.column]}`);
  say(!notNum.length, notNum.length ? `not numeric any more: ${notNum.join(", ")}` : "summed columns are numeric");
  if (missing.length) return;

  // One real totals query, built the way the connector builds it, for the current year.
  const year = new Date().getFullYear();
  const stats = s.measures.map((m) => ({ statisticType: m.fn, onStatisticField: m.fn === "count" ? s.count_field : m.column, outStatisticFieldName: m.as }));
  const q = new URLSearchParams({ f: "json", returnGeometry: "false", where: `${s.filters[s.cycle_filter].column} = ${year}`, groupByFieldsForStatistics: s.group_by.join(","), outStatistics: JSON.stringify(stats), orderByFields: s.order_by });
  try {
    const r = await get(`${layer}/query?${q}`);
    const groups = r.ok ? r.body.features.length : 0;
    say(r.ok && groups > 0, `totals query for ${year} answers (${r.status}, ${groups} groups)`);
    if (r.ok) say(r.body.exceededTransferLimit !== true, r.body.exceededTransferLimit === true ? `the answer for ${year} is cut off at the server's maximum, so a year filter is no longer enough` : `the answer for ${year} is complete (not cut off)`);
    const maxes = [["updated", s.freshness_column], ["newest", s.newest_column]].filter(([, c]) => c);
    const f = await get(`${layer}/query?${new URLSearchParams({ f: "json", returnGeometry: "false", where: "1=1", outStatistics: JSON.stringify(maxes.map(([as, c]) => ({ statisticType: "max", onStatisticField: c, outStatisticFieldName: as }))) })}`);
    const stamp = Object.fromEntries(Object.entries(f.body?.features?.[0]?.attributes || {}).map(([k, v]) => [k.toLowerCase(), v]));
    say(f.ok && typeof stamp.updated === "number", "last-modified date answers");
    if (typeof stamp.updated === "number") console.log(`       data last updated ${new Date(stamp.updated).toISOString().slice(0, 10)}`);
  } catch (e) {
    say(false, `query failed: ${e.message}`);
  }
}

const described = new Map(); // one fetch of each API description per run
async function verifyOcpf(s) {
  try {
    if (!described.has(s.catalog_record)) {
      const r = await fetch(s.catalog_record, { signal: AbortSignal.timeout(60000) });
      described.set(s.catalog_record, r.ok ? await r.json() : null);
    }
    const doc = described.get(s.catalog_record);
    say(Boolean(doc), "API description answers");
    if (doc) {
      say(doc.info?.title === s.dataset_name, `title unchanged: "${String(doc.info?.title).slice(0, 70)}"`);
      say(String(doc.info?.description || "").includes(s.publisher), `publisher still named in the API's description: "${s.publisher}"`);
      say((doc.info?.contact?.url ?? null) === (s.publisher_link ?? null), `publisher link unchanged: ${doc.info?.contact?.url ?? "(none)"}`);
      say(Boolean(doc.paths?.[s.dataset]?.get), `the description still lists ${s.dataset}`);
    }
  } catch (e) {
    say(false, `could not read the API description: ${e.message}`);
  }
  const year = new Date().getFullYear();
  try {
    const r = await fetch(`https://${s.domain}${s.dataset.replace("{year}", String(year))}`, { signal: AbortSignal.timeout(60000) });
    const body = r.ok ? await r.json() : null;
    const rows = Array.isArray(body) ? body : body?.[s.rows_key];
    say(r.ok && Array.isArray(rows), `list for ${year} answers (${r.status}, ${Array.isArray(rows) ? rows.length : 0} filers)`);
    if (!Array.isArray(rows) || !rows.length) {
      if (Array.isArray(rows)) console.log(`       empty for ${year}: nothing to check columns against`);
      return;
    }
    const missing = s.select.filter((c) => !(c in rows[0]));
    say(!missing.length, missing.length ? `columns gone: ${missing.join(", ")}` : `all ${s.select.length} columns still present`);
    const notNum = (s.numeric || []).filter((c) => rows[0][c] !== null && typeof rows[0][c] !== "number");
    say(!notNum.length, notNum.length ? `not numeric any more: ${notNum.join(", ")}` : "numeric columns are numeric");
    const person = Object.keys(rows[0]).filter((k) => /addr|street|zip|phone|email|employer|occup|contributor|donor/i.test(k));
    say(!person.length, person.length ? `the list now carries person-level fields: ${person.join(", ")}` : "the list carries no donor or contact field");
    const dates = rows.map((x) => String(x[s.newest_column] || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)).filter(Boolean).map((m) => `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`).sort();
    say(dates.length > 0, "report dates are still M/D/YYYY text");
    if (dates.length) console.log(`       newest reporting period ends ${dates.pop()}`);
  } catch (e) {
    say(false, `query failed: ${e.message}`);
  }
}

for (const s of reg.sources) {
  console.log(`\n${s.id}  (${s.domain}/${String(s.dataset).replace(/^\//, "")})`);
  if (s.platform === "ocpf") {
    await verifyOcpf(s);
    continue;
  }
  if (s.platform === "carto") {
    await verifyCarto(s);
    continue;
  }
  if (s.platform === "arcgis") {
    await verifyArcgis(s);
    continue;
  }
  let view;
  try {
    const r = await fetch(`https://${s.domain}/api/views/${s.dataset}.json`, { signal: AbortSignal.timeout(45000) });
    say(r.ok, `dataset metadata answers (${r.status})`);
    if (!r.ok) continue;
    view = await r.json();
  } catch (e) {
    say(false, `could not reach ${s.domain}: ${e.message}`);
    continue;
  }
  say((view.attribution ?? null) === (s.publisher ?? null), `publisher credit unchanged: "${view.attribution ?? "(none)"}"`);
  say((view.attributionLink ?? null) === (s.publisher_link ?? null), `publisher link unchanged: ${view.attributionLink ?? "(none)"}`);
  say(view.name === s.dataset_name || view.name.startsWith(s.dataset_name), `title unchanged: "${view.name.slice(0, 70)}"`);
  if (s.terms?.description_contains) say(String(view.description || "").includes(s.terms.description_contains), `the publisher's condition is still in the description ("${s.terms.description_contains}")`);
  for (const [group, fields] of Object.entries(s.metadata_check || {})) {
    for (const [field, want] of Object.entries(fields)) {
      const got = view.metadata?.custom_fields?.[group]?.[field] ?? null;
      say(got === want, `metadata ${group} / ${field} unchanged: ${JSON.stringify(got)}`);
    }
  }

  const type = Object.fromEntries(view.columns.map((c) => [c.fieldName, c.dataTypeName]));
  const used = [...(s.select || []), ...(s.group_by || []), ...(s.measures || []).map((m) => m.column).filter(Boolean), ...Object.values(s.filters).map((f) => f.column)];
  const missing = [...new Set(used)].filter((c) => !(c in type));
  say(!missing.length, missing.length ? `columns gone: ${missing.join(", ")}` : `all ${new Set(used).size} columns still present`);
  const summed = [...(s.numeric || []), ...(s.measures || []).filter((m) => m.fn === "sum").map((m) => m.column)];
  const notNum = summed.filter((c) => type[c] !== "number");
  say(!notNum.length, notNum.length ? `not numeric any more: ${notNum.map((c) => `${c}:${type[c]}`).join(", ")}` : "summed columns are numeric");

  // One real query, built the way the connector builds it, with no filters.
  const q = new URLSearchParams();
  if (s.mode === "grouped") {
    q.set("$select", [...s.group_by, ...s.measures.map((m) => (m.fn === "count" ? `count(*) as ${m.as}` : `${m.fn}(${m.column}) as ${m.as}`))].join(","));
    q.set("$group", s.group_by.join(","));
  } else q.set("$select", s.select.join(","));
  q.set("$order", s.order_by);
  q.set("$limit", "1");
  try {
    const r = await fetch(`https://${s.domain}/resource/${s.dataset}.json?${q}`, { signal: AbortSignal.timeout(60000) });
    const rows = r.ok ? await r.json() : [];
    say(r.ok && rows.length === 1, `one-row query answers (${r.status}, ${rows.length} row)`);
  } catch (e) {
    say(false, `query failed: ${e.message}`);
  }
  if (view.rowsUpdatedAt) console.log(`       data last updated ${new Date(view.rowsUpdatedAt * 1000).toISOString().slice(0, 10)}`);
}
console.log(bad ? `\n${bad} check(s) need attention. Do not update verified_on until they are resolved.` : `\nAll sources verified live. verified_on in sources.json is ${reg.verified_on}.`);
process.exit(bad ? 1 : 0);
