#!/usr/bin/env node
/**
 * Jurisdiction MCP server (zero dependency, stdio transport, no API key).
 *
 * Turns a street address into the districts it sits in, then connects to
 * whatever state or local campaign-finance data can be reached for them.
 *
 * Two jobs:
 *   1. jx_locate    address -> state, county, city, school district, congressional
 *                   district and both state legislative districts, via the US Census
 *                   Bureau geocoder. Also names the federal race, for use with a
 *                   separate federal (FEC) connector if one is connected.
 *   2. jx_sources / jx_race_totals
 *                   a small registry (sources.json) of state and local datasets that
 *                   were checked live, queried with fixed aggregate queries only.
 *
 * Most states are NOT in the registry, and that is the normal case. For those the
 * server says so, hands back the geography and search queries built from it, and
 * leaves finding and verifying the regulator to the assistant. It never names an
 * agency it did not fetch.
 *
 * API facts, observed live on 2026-10-04 unless noted:
 *   Census geocoder   https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress
 *                     params: address, benchmark=Public_AR_Current, vintage=Current_Current,
 *                     layers=all, format=json. No key. Layer names carry their own vintage
 *                     ("120th Congressional Districts", "2026 State Legislative Districts -
 *                     Upper"), the city layer is "Incorporated Places" or "Census Designated
 *                     Places", and "Unified School Districts" was present. A street address
 *                     is required; a ZIP alone is rejected here because it can span districts.
 *                     City council wards, county commission districts and special districts
 *                     were not among the returned layers.
 *   Socrata (SODA)    https://<domain>/resource/<dataset>.json and /api/views/<dataset>.json.
 *                     No key (throttled, fine at this volume). Numbers come back as strings.
 *                     Exact-match filters are plain query parameters.
 *   Carto SQL API     https://<domain>/api/v2/sql?q=<one SQL statement>. No key. Observed
 *                     2026-10-05. The answer is {rows, fields, total_rows}; fields gives each
 *                     returned column's type, and numbers come back as numbers. A bad column
 *                     is a 400 with {"error":["column \"x\" does not exist"]}. There are no
 *                     bound parameters and no publisher credit or "last updated" in the
 *                     answer, so the credit comes from the city's catalogue record at verify
 *                     time and freshness is read from the data (newest report date).
 *   ArcGIS REST       https://<domain><service_path>/<layer>?f=json (metadata: name,
 *                     copyrightText, fields) and .../<layer>/query. No key. Observed
 *                     2026-10-05 on DC's server (version 11.5). Totals are done by the
 *                     server with groupByFieldsForStatistics + outStatistics. Four things
 *                     to know: paging parameters are ignored on a statistics query (every
 *                     group comes back, up to maxRecordCount 1000), so the row limit is
 *                     applied here; a failed query is an HTTP 200 with {"error":{...}};
 *                     statistic names come back upper-cased; and dates are epoch
 *                     milliseconds. Groups with no amounts sort first, so sorting is
 *                     redone here with empty totals last.
 *   OCPF Public API   https://api.ocpf.us/reports/<kind>/<year> (Massachusetts). No key.
 *                     Described at /swagger/index.html. Observed 2026-10-05. Each answer is
 *                     a list of filers with year-to-date totals and no donor fields. Five
 *                     things to know: the year is part of the path; the sort and page
 *                     parameters are ignored, so sorting and the row limit are applied
 *                     here; a wrong year, and even a wrong path, answers 200 with an empty
 *                     list; dates are M/D/YYYY text; and there is no way to ask the server
 *                     for one city or district, so that narrowing is done here on the rows
 *                     that came back (a "local" filter, compared and never sent).
 *
 * AGGREGATE-ONLY BY CONSTRUCTION: callers never write queries. Each registry entry
 * fixes its $select, $group and $order; callers may only set allow-listed filters, and
 * filter values are passed as plain parameters, never spliced into $where. At load,
 * any entry that selects a person-level column (contributor, employer, address and so
 * on) is refused.
 *
 * Carto and ArcGIS take SQL text (a whole statement, or a where clause), so the same
 * promise is kept another way: such an entry may only declare integer filters (digits),
 * enum filters (a pick from a list in the registry, sent in the registry's own
 * spelling) and present filters (yes or no: is this column filled in). Nothing a caller
 * types reaches the SQL as text. At load, an entry on those platforms with a free-text
 * filter, or with a table, column or list value that is not plain, is refused.
 *
 * PRIVACY: the street address is sent to the Census Bureau and is not stored or echoed
 * by this server. A candidate's home address is sensitive; use an office or a public
 * building when the question allows.
 */

const fs = require("node:fs");
const path = require("node:path");

// An unset ${VAR} in .mcp.json reaches the server as the literal text "${VAR}".
function envVar(name) {
  const v = process.env[name] || "";
  return /^\$\{[^}]*\}$/.test(v) ? "" : v;
}

const CENSUS_BASE = (envVar("JX_CENSUS_BASE") || "https://geocoding.geo.census.gov/geocoder").replace(/\/$/, "");
// Tests point every Socrata domain at one local stand-in.
const SOCRATA_OVERRIDE = envVar("JX_SOCRATA_BASE").replace(/\/$/, "");
const CARTO_OVERRIDE = envVar("JX_CARTO_BASE").replace(/\/$/, "");
const ARCGIS_OVERRIDE = envVar("JX_ARCGIS_BASE").replace(/\/$/, "");
const OCPF_OVERRIDE = envVar("JX_OCPF_BASE").replace(/\/$/, "");
const SERVER_NAME = "jurisdiction";
const SERVER_VERSION = "0.5.0";

const INSTRUCTIONS = [
  "Rules for this connection:",
  "- No API key is needed here, and never ask the user to paste an API key or secret into the chat.",
  "- Report aggregates. This server returns totals and committee or candidate names, never individual donors, and it cannot be made to. Do not try to work back to individual donors, and do not help turn campaign-finance data into a mailing or solicitation list.",
  "- jx_locate sends the street address to the US Census Bureau. A candidate's home address is sensitive: prefer a campaign office or other public address when the question allows, and never repeat the address in documents or shared channels.",
  "- Most states are not connected. When jx_sources or jx_locate says a place is not connected, say so plainly, then help the user find their own regulator: search for it, open the official government site, confirm it covers their office, and give the user that URL. Do not name a regulator, or state its rules, deadlines or limits, from memory. Only the sites you actually opened count.",
  "- Different offices in the same place can file with different bodies (state, county, city, school district). Ask which office the user is running for before deciding where to look.",
  "- Every connected source names its publisher and the date it was verified. Report both, and say how fresh the data is. Totals are as filed, not audited.",
].join("\n");

class ApiError extends Error {}

/* ---------------------------------------------------------------- registry */
const HERE = __dirname;

// A registry entry that selects or filters on a column like these would put
// individual donors in an answer. Refuse it at load rather than trust review.
const PERSON_COLUMN = /contributor|donor|employ|occupation|address|phone|email|street|zip|treasurer|first_?name|last_?name|^name$|^con_|^recipid$/i;

const PLATFORM_NAMES = ["socrata", "carto", "arcgis", "ocpf"];
// Platforms whose request carries SQL text built here.
const SQL_PLATFORMS = ["carto", "arcgis"];
// What may be written into that SQL text. List values allow no quote character,
// so quoting one can never end the string early.
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_ORDER = /^[A-Za-z_][A-Za-z0-9_]* (ASC|DESC)$/;
const ENUM_VALUE = /^[\p{L}\p{N} _.,&()\-/]{1,80}$/u;

function loadRegistry() {
  // JX_SOURCES_FILE exists so tests can prove a bad registry is refused; nothing else sets it.
  const raw = JSON.parse(fs.readFileSync(envVar("JX_SOURCES_FILE") || path.join(HERE, "sources.json"), "utf8"));
  const problems = [];
  for (const s of raw.sources) {
    const platform = s.platform || "socrata";
    const cols = [
      ...(s.select || []),
      ...(s.group_by || []),
      ...(s.measures || []).map((m) => m.column).filter(Boolean),
      ...Object.values(s.filters || {}).map((f) => f.column).filter(Boolean),
      ...Object.keys(s.require_in || {}),
      ...[s.freshness_column, s.newest_column, s.count_field].filter(Boolean),
    ];
    for (const c of cols) if (PERSON_COLUMN.test(c)) problems.push(`${s.id}: person-level column "${c}"`);
    if (!s.mode || !["rows", "grouped"].includes(s.mode)) problems.push(`${s.id}: mode must be rows or grouped`);
    if (!PLATFORM_NAMES.includes(platform)) problems.push(`${s.id}: unknown platform "${platform}"`);
    // Value lists: enum filters, and require_in (a fixed condition every query carries).
    const lists = [
      ...Object.entries(s.filters || {}).filter(([, f]) => f.type === "enum").map(([k, f]) => [`enum filter "${k}"`, f.values]),
      ...Object.entries(s.require_in || {}).map(([c, values]) => [`require_in "${c}"`, values]),
    ];
    for (const [what, values] of lists) {
      if (!Array.isArray(values) || !values.length) problems.push(`${s.id}: ${what} lists no values`);
      else for (const v of values) if (typeof v !== "string" || !ENUM_VALUE.test(v)) problems.push(`${s.id}: ${what} has a value that is not plain text: ${JSON.stringify(v)}`);
    }
    const sql = SQL_PLATFORMS.includes(platform);
    if (s.require_in && !sql) problems.push(`${s.id}: require_in is only built for ${SQL_PLATFORMS.join(" and ")} sources`);
    for (const [k, f] of Object.entries(s.filters || {})) {
      if (f.type === "present" && !sql) problems.push(`${s.id}: a present filter ("${k}") is only built for ${SQL_PLATFORMS.join(" and ")} sources`);
    }
    // Every source carries what its publisher's terms say, read at the source on a known date.
    const terms = s.terms;
    if (!terms || typeof terms !== "object") problems.push(`${s.id}: terms is missing`);
    else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(terms.read_on))) problems.push(`${s.id}: terms.read_on must be a date`);
      if (!/^https:\/\//.test(String(terms.source))) problems.push(`${s.id}: terms.source must be a web address`);
      if (typeof terms.summary !== "string" || !terms.summary) problems.push(`${s.id}: terms.summary is missing`);
      if (!(terms.condition === null || (typeof terms.condition === "string" && terms.condition))) problems.push(`${s.id}: terms.condition must be the publisher's words or null`);
    }
    if (s.cycle_filter_required && !Object.hasOwn(s.filters || {}, s.cycle_filter)) problems.push(`${s.id}: cycle_filter_required needs cycle_filter to name one of its filters`);
    if (sql) {
      for (const [k, f] of Object.entries(s.filters || {})) {
        if (!["integer", "enum", "present"].includes(f.type)) problems.push(`${s.id}: ${platform} sources may only take integer, enum or present filters, and "${k}" is ${f.type}`);
      }
      const names = [...cols, ...(s.measures || []).map((m) => m.as), ...(platform === "carto" ? [s.dataset] : [])];
      for (const name of names) if (!SQL_IDENT.test(String(name))) problems.push(`${s.id}: "${name}" is not a plain table or column name`);
      if (!SQL_ORDER.test(String(s.order_by))) problems.push(`${s.id}: order_by must be one column and ASC or DESC`);
      if (!/^https:\/\//.test(String(s.dataset_url))) problems.push(`${s.id}: ${platform} sources need a dataset_url`);
    }
    for (const [k, f] of Object.entries(s.filters || {})) {
      // A local filter is compared against rows already fetched and is never sent anywhere.
      if (f.type === "local" && !(s.select || []).includes(f.column)) problems.push(`${s.id}: local filter "${k}" must name a column in select`);
      if (f.type === "local" && platform !== "ocpf") problems.push(`${s.id}: a local filter ("${k}") is only built for ocpf sources`);
    }
    if (platform === "ocpf") {
      if (s.mode !== "rows") problems.push(`${s.id}: an ocpf source must use mode rows`);
      if (!/^(\/[A-Za-z]+)+\/\{year\}$/.test(String(s.dataset))) problems.push(`${s.id}: an ocpf dataset is a plain path ending in {year}`);
      if (!s.cycle_filter_required) problems.push(`${s.id}: an ocpf source must require its year`);
      if (!SQL_ORDER.test(String(s.order_by)) || !(s.select || []).includes(String(s.order_by).split(" ")[0])) problems.push(`${s.id}: order_by must be one selected column and ASC or DESC`);
      for (const [k, f] of Object.entries(s.filters || {})) {
        const ok = (f.in === "path" && f.type === "integer") || (f.in === "query" && ["boolean", "enum"].includes(f.type) && /^[A-Za-z]+$/.test(String(f.param))) || f.type === "local";
        if (!ok) problems.push(`${s.id}: filter "${k}" is not one an ocpf source can take (the year in the path, a yes/no or listed value as a parameter, or a local filter)`);
      }
    }
    if (platform === "carto" && s.mode !== "rows") problems.push(`${s.id}: a carto source must use mode rows`);
    if (platform === "arcgis") {
      if (s.mode !== "grouped") problems.push(`${s.id}: an arcgis source must use mode grouped`);
      if (!/^\d{1,4}$/.test(String(s.dataset))) problems.push(`${s.id}: an arcgis dataset is a layer number`);
      if (!/^(\/[A-Za-z0-9_]+)+$/.test(String(s.service_path))) problems.push(`${s.id}: service_path is not a plain path`);
      if (!s.count_field) problems.push(`${s.id}: an arcgis source needs a count_field`);
      for (const m of s.measures || []) if (!["sum", "count"].includes(m.fn)) problems.push(`${s.id}: measure "${m.as}" must be sum or count`);
    }
  }
  if (problems.length) throw new Error(`sources.json refused: ${problems.join("; ")}`);
  return raw;
}
const REGISTRY = loadRegistry();
const SOURCES = new Map(REGISTRY.sources.map((s) => [s.id, s]));

const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function matches(source, { state, place }) {
  if (!state || source.match.state !== state) return false;
  if (!source.match.place) return true;
  return Boolean(place) && new RegExp(source.match.place, "i").test(place);
}

function sourceCard(s) {
  return {
    id: s.id,
    dataset_name: s.dataset_name,
    publisher: s.publisher ?? null,
    publisher_link: s.publisher_link ?? null,
    ...(s.publisher_is_agency === false ? { publisher_note: "The dataset's own credit names the city or its open-data portal, not a specific agency. Find the office responsible on the city's own site before naming one." } : {}),
    dataset_url: s.dataset_url || `https://${s.domain}/d/${s.dataset}`,
    covers: s.covers,
    covers_basis: s.covers_basis,
    verified_on: REGISTRY.verified_on,
    publisher_terms: { read_on: s.terms.read_on, source: s.terms.source, summary: s.terms.summary, condition: s.terms.condition },
    filters: Object.fromEntries(Object.entries(s.filters).map(([k, f]) => [k, f.type === "enum" ? `one of: ${f.values.join(" | ")}` : f.type === "present" || f.type === "boolean" ? "yes or no" : f.type === "local" ? "text, matched against the rows returned" : f.type])),
    ...(s.cycle_filter_required ? { required_filters: [s.cycle_filter] } : {}),
  };
}

/* ------------------------------------------------------------------ client */
let lastCall = 0;
const MIN_GAP_MS = 400;
let chain = Promise.resolve();
function throttled(fn) {
  const run = async () => {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  };
  const result = chain.then(run, run);
  chain = result.then(() => {}, () => {});
  return result;
}

async function getJson(url, label) {
  let res;
  try {
    res = await throttled(() => fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45000) }));
  } catch (err) {
    throw new ApiError(`Could not reach ${label}: ${err?.name === "TimeoutError" ? "it took too long to answer" : err?.message || err}. Try again in a minute.`);
  }
  const text = await res.text();
  if (res.status === 429) throw new ApiError(`${label} is rate limiting this connection. Wait a minute and try again.`);
  if (!res.ok) {
    // Socrata sends {errorCode}; Carto sends {error: ["column \"x\" does not exist"]}.
    let code = "";
    try {
      const j = JSON.parse(text);
      code = j.errorCode || (Array.isArray(j.error) ? j.error.join(" ") : "");
    } catch {}
    if (/no-such-column|(column|relation) .* does not exist/.test(code)) {
      throw new ApiError(`${label} no longer has a column this connector expects, so the publisher has changed the dataset. The registry entry needs re-verifying (tests/verify-jurisdiction-sources.mjs); do not trust a workaround.`);
    }
    throw new ApiError(`${label} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`Could not parse ${label}'s response as JSON: ${text.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ census */
function validateAddress(raw) {
  const a = String(raw ?? "").trim();
  if (!a) throw new ApiError("Give a street address, like '301 W 2nd St, Austin, TX 78701'.");
  if (/^\d{5}(-\d{4})?$/.test(a)) {
    throw new ApiError("A ZIP code is not enough. One ZIP can sit in several congressional and legislative districts, so the answer would be a guess. Give a street address, ideally the campaign office or another public address.");
  }
  if (a.length < 8 || !/^\d+[\w\-/]*\s+\S+/.test(a)) {
    throw new ApiError("That does not look like a street address. Start with the street number, for example '600 4th Ave, Seattle, WA 98104'.");
  }
  return a;
}

const first = (g, re) => {
  const k = Object.keys(g).find((l) => re.test(l));
  return k ? { layer: k, rec: g[k][0] } : null;
};
const stripZeros = (s) => (s == null ? null : String(s).replace(/^0+(?=\d)/, ""));
const stripCounty = (n) => (n ? n.replace(/\s+(County|Parish|Borough|Census Area|Municipality|city)$/i, "") : n);

function readGeography(g) {
  const st = first(g, /^States$/);
  const county = first(g, /^Counties$/);
  const place = first(g, /^Incorporated Places$/) || first(g, /^Census Designated Places$/);
  const sub = first(g, /^County Subdivisions$/);
  const cd = first(g, /Congressional Districts$/);
  const up = first(g, /State Legislative Districts - Upper$/);
  const lo = first(g, /State Legislative Districts - Lower$/);
  const schools = Object.keys(g)
    .filter((l) => /School Districts$/.test(l))
    .map((l) => ({ type: l, name: g[l][0].NAME }));
  const cdKey = cd && Object.keys(cd.rec).find((k) => /^CD\d+$/.test(k));
  return {
    state: st ? { abbr: st.rec.STUSAB, name: st.rec.NAME } : null,
    county: county ? { name: county.rec.NAME } : null,
    place: place ? { name: place.rec.NAME, kind: place.layer === "Incorporated Places" ? "incorporated place" : "census designated place (not a municipality)" } : null,
    county_subdivision: sub ? { name: sub.rec.NAME } : null,
    school_districts: schools,
    congressional_district: cd ? { number: cd.rec[cdKey], name: cd.rec.NAME, layer: cd.layer } : null,
    state_senate_district: up ? { number: up.rec.SLDU, name: up.rec.NAME, layer: up.layer } : null,
    state_house_district: lo ? { number: lo.rec.SLDL, name: lo.rec.NAME, layer: lo.layer } : null,
  };
}

function templateVars(geo) {
  const year = String(new Date().getFullYear());
  const county = stripCounty(geo.county?.name);
  return {
    $year: year,
    $sldu: stripZeros(geo.state_senate_district?.number),
    $sldl: stripZeros(geo.state_house_district?.number),
    $cd: geo.congressional_district?.number,
    $county: county,
    $county_upper: county ? county.toUpperCase() : null,
    $place: geo.place?.name,
    // "Boston city" -> "Boston"; "14th Suffolk District" -> "14th Suffolk".
    $place_short: geo.place?.name ? geo.place.name.replace(/\s+(city|town|village|borough)$/i, "") : null,
    $sldu_name: geo.state_senate_district?.name ? geo.state_senate_district.name.replace(/\s+District$/i, "") : null,
    $sldl_name: geo.state_house_district?.name ? geo.state_house_district.name.replace(/\s+District$/i, "") : null,
  };
}

function suggestedCalls(source, vars) {
  const out = [];
  for (const s of source.suggestions || []) {
    const filters = {};
    let ok = true;
    for (const [k, v] of Object.entries(s.filters)) {
      // A value is a literal, one variable, or text with variables in it ("Mayoral, $place_short").
      let val = v;
      if (typeof v === "string" && v in vars) val = vars[v];
      else if (typeof v === "string" && v.includes("$")) {
        val = v.replace(/\$[a-z_]+/g, (name) => {
          if (vars[name] == null || vars[name] === "") ok = false;
          return vars[name] ?? "";
        });
      }
      if (val == null || val === "") ok = false;
      else filters[k] = val;
    }
    if (ok) out.push({ tool: "jx_race_totals", label: s.label, arguments: { source_id: source.id, filters } });
  }
  return out;
}

function howToFind(geo) {
  const stateName = geo.state?.name;
  const q = [];
  if (stateName) q.push(`${stateName} campaign finance disclosure search`, `${stateName} state elections office candidate campaign finance reports`);
  if (geo.county && stateName) q.push(`${geo.county.name} ${stateName} elections office local candidate campaign finance`);
  if (geo.place?.kind === "incorporated place") q.push(`${geo.place.name} ${stateName} city clerk candidate campaign finance reports`);
  if (geo.school_districts?.length) q.push(`${geo.school_districts[0].name} school board candidate campaign finance`);
  return {
    search_queries: q,
    steps: [
      "Ask the user which office they are running for. State legislative, county, city and school board races can each file with a different body.",
      "Search the queries above, open the official government site that comes up, and confirm it covers that office.",
      "Give the user that URL. Do not name the regulator, or describe its rules, deadlines or limits, unless it is on the page you opened.",
      "If the site offers a downloadable report or an open-data portal, say so and let the user decide whether to share an export.",
    ],
  };
}

const CANNOT_COVER = [
  "City council wards, county commission districts and special districts (fire, water, community college) were not among the layers the Census geocoder returned. Ask the campaign for its district, and check the jurisdiction's own maps.",
  "A Census \"place\" is a statistical area as well as a municipality; a census designated place is not a city government.",
  "School district boundaries are returned as the Census names them; some places have separate elementary and secondary districts.",
];

async function locate(address) {
  const a = validateAddress(address);
  const url = new URL(`${CENSUS_BASE}/geographies/onelineaddress`);
  url.searchParams.set("address", a);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("vintage", "Current_Current");
  url.searchParams.set("layers", "all");
  url.searchParams.set("format", "json");
  const j = await getJson(url, "the Census geocoder");
  if (j.errors?.length) throw new ApiError(`The Census geocoder rejected the request: ${JSON.stringify(j.errors).slice(0, 200)}`);
  const m = j.result?.addressMatches?.[0];
  if (!m) {
    return {
      matched: false,
      message: "The Census geocoder found no match for that address. Check the street number, spelling and ZIP, or try a nearby public building. Some new or rural addresses are not in its reference data.",
    };
  }
  return { matched: true, geo: readGeography(m.geographies) };
}

/* ----------------------------------------------------------------- socrata */
const datasetBase = (s) => (SOCRATA_OVERRIDE || `https://${s.domain}`);
const TEXT_VALUE = /^[\p{L}\p{N} .,'&()\-/]{1,80}$/u;
const INT_VALUE = /^\d{1,6}$/;

// The one place a caller's filter is checked, for every platform. An enum answer is
// the registry's own spelling of the value, not the caller's text.
function filterValue(source, k, v) {
  const allowed = source.filters;
  if (!Object.hasOwn(allowed, k)) throw new ApiError(`"${k}" is not a filter this source supports. Allowed: ${Object.keys(allowed).join(", ")}.`);
  const f = allowed[k];
  const s = String(v).trim();
  if (f.type === "enum") {
    const hit = f.values.find((x) => x.toLowerCase() === s.toLowerCase());
    if (!hit) throw new ApiError(`The value for "${k}" must be one of: ${f.values.join(", ")}.`);
    return hit;
  }
  if (f.type === "present" || f.type === "boolean") {
    if (/^(yes|true)$/i.test(s)) return f.type === "boolean" ? "true" : "yes";
    if (/^(no|false)$/i.test(s)) return f.type === "boolean" ? "false" : "no";
    throw new ApiError(`The value for "${k}" must be yes or no.`);
  }
  if (!(f.type === "integer" ? INT_VALUE : TEXT_VALUE).test(s)) throw new ApiError(`The value for "${k}" is not valid (${f.type === "integer" ? "digits only" : "letters, digits and basic punctuation, up to 80 characters"}).`);
  return s;
}

function buildQuery(source, filters, limit) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) {
    const value = filterValue(source, k, v);
    q.set(source.filters[k].column, value);
  }
  if (source.mode === "grouped") {
    const measures = source.measures.map((m) => (m.fn === "count" ? `count(*) as ${m.as}` : `${m.fn}(${m.column}) as ${m.as}`));
    q.set("$select", [...source.group_by, ...measures].join(","));
    q.set("$group", source.group_by.join(","));
  } else {
    q.set("$select", source.select.join(","));
  }
  q.set("$order", source.order_by);
  q.set("$limit", String(limit));
  return q;
}

function shapeRows(source, rows) {
  const numeric = new Set(source.mode === "grouped" ? source.measures.map((m) => m.as) : source.numeric || []);
  // Socrata leaves null fields out of a row entirely. Fill them in as explicit
  // nulls so every row has the same keys and "missing" is never read as zero.
  const keys = source.mode === "grouped" ? [...source.group_by, ...source.measures.map((m) => m.as)] : source.select;
  const dates = new Set(source.dates || []);
  return rows.map((r) => {
    const o = {};
    for (const k of keys) {
      const v = r[k] ?? null;
      if (dates.has(k) && typeof v === "string") o[k] = v.slice(0, 10);
      else o[k] = numeric.has(k) && v !== null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    return o;
  });
}

async function runSocrata(source, query) {
  const base = datasetBase(source);
  const [rows, view] = await Promise.all([
    getJson(`${base}/resource/${source.dataset}.json?${query}`, `${source.domain}`),
    getJson(`${base}/api/views/${source.dataset}.json`, `${source.domain} metadata`).catch(() => null),
  ]);

  const drift = [];
  if (view) {
    if ((view.attribution ?? null) !== (source.publisher ?? null)) {
      drift.push(`The publisher on the dataset now reads "${view.attribution ?? "(none)"}", but this connector was verified against "${source.publisher ?? "(none)"}". Re-verify before relying on the publisher name.`);
    }
    if ((view.name ?? null) !== source.dataset_name) drift.push(`The dataset is now titled "${view.name}"; it was verified as "${source.dataset_name}".`);
  } else {
    drift.push("Could not read the dataset's metadata, so its freshness and publisher were not re-checked this time.");
  }
  return { rows, drift, updated: { data_updated_at: view?.rowsUpdatedAt ? new Date(view.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null }, notes: [] };
}

/* ------------------------------------------------------------------- carto */
const cartoBase = (s) => (CARTO_OVERRIDE || `https://${s.domain}`);
const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

// Every piece of this statement is registry text checked at load, a row limit, or
// a filter value that filterValue() has reduced to digits or the registry's own enum
// spelling (or yes/no for a present filter). require_in is a fixed condition on
// every query, which is how a source leaves out kinds of row (for Philadelphia,
// filers who are private individuals or businesses).
function sqlConditions(source, filters) {
  const where = Object.entries(source.require_in || {}).map(([c, values]) => `${c} IN (${values.map(sqlText).join(", ")})`);
  for (const [k, v] of Object.entries(filters || {})) {
    const value = filterValue(source, k, v);
    const f = source.filters[k];
    if (f.type === "present") where.push(`${f.column} IS ${value === "yes" ? "NOT NULL" : "NULL"}`);
    else where.push(`${f.column} = ${f.type === "integer" && !f.stored_as_text ? value : sqlText(value)}`);
  }
  return where;
}

// NULLS LAST because Postgres would otherwise put empty totals first.
function buildCartoSql(source, filters, limit) {
  const where = sqlConditions(source, filters);
  const [column, direction] = source.order_by.split(" ");
  return `SELECT ${source.select.join(", ")} FROM ${source.dataset}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${column} ${direction} NULLS LAST LIMIT ${limit}`;
}

async function runCarto(source, sql) {
  const url = (q) => `${cartoBase(source)}/api/v2/sql?${new URLSearchParams({ q })}`;
  const [answer, fresh] = await Promise.all([
    getJson(url(sql), `${source.domain}`),
    source.freshness_column
      ? getJson(url(`SELECT max(${source.freshness_column}) AS latest FROM ${source.dataset}`), `${source.domain} freshness`).catch(() => null)
      : null,
  ]);
  if (!Array.isArray(answer?.rows)) throw new ApiError(`${source.domain} answered without a rows list, so the publisher has changed how it responds. The registry entry needs re-verifying (tests/verify-jurisdiction-sources.mjs).`);

  const drift = [];
  const notNumbers = (source.numeric || []).filter((c) => answer.fields?.[c] && answer.fields[c].type !== "number");
  if (notNumbers.length) drift.push(`The publisher no longer sends these as numbers: ${notNumbers.join(", ")}. Re-verify before relying on the totals.`);
  const latest = typeof fresh?.rows?.[0]?.latest === "string" ? fresh.rows[0].latest.slice(0, 10) : null;
  if (source.freshness_column && !latest) drift.push("Could not read the newest report date, so the data's freshness was not re-checked this time.");

  return {
    rows: answer.rows,
    drift,
    updated: { data_updated_at: null, newest_report_date: latest },
    notes: [
      latest
        ? `This platform does not say when the table was last refreshed. The newest report in it is dated ${latest}.`
        : "This platform does not say when the table was last refreshed.",
      `This platform carries no publisher credit with the data. The credit shown was read from ${source.dataset_url} on ${REGISTRY.verified_on} and was not re-checked on this call.`,
    ],
  };
}

// For platforms that do not sort for us: order by one numeric column, empty values last.
function sortRows(rows, orderBy) {
  const [key, direction] = orderBy.split(" ");
  const empty = (v) => v === null || v === undefined;
  return rows.sort((a, b) => empty(a[key]) - empty(b[key]) || (direction === "DESC" ? b[key] - a[key] : a[key] - b[key]));
}

/* ------------------------------------------------------------------ arcgis */
const arcgisLayer = (s) => `${ARCGIS_OVERRIDE || `https://${s.domain}`}${s.service_path}/${s.dataset}`;
const statsQuery = (where, extra) => new URLSearchParams({ f: "json", returnGeometry: "false", where, ...extra });

function buildArcgisQuery(source, filters, limit) {
  const where = sqlConditions(source, filters);
  const stats = source.measures.map((m) => ({ statisticType: m.fn, onStatisticField: m.fn === "count" ? source.count_field : m.column, outStatisticFieldName: m.as }));
  return {
    limit,
    query: statsQuery(where.length ? where.join(" AND ") : "1=1", {
      groupByFieldsForStatistics: source.group_by.join(","),
      outStatistics: JSON.stringify(stats),
      orderByFields: source.order_by,
    }),
  };
}

// Dates arrive as epoch milliseconds, and a date with no time arrives as midnight
// UTC (observed on DC's layer), so the UTC date is the one the publisher wrote.
const epochDate = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);

async function runArcgis(source, { query, limit }) {
  const layer = arcgisLayer(source);
  const maxes = [source.freshness_column && ["updated", source.freshness_column], source.newest_column && ["newest", source.newest_column]].filter(Boolean);
  const freshQuery = statsQuery("1=1", { outStatistics: JSON.stringify(maxes.map(([as, column]) => ({ statisticType: "max", onStatisticField: column, outStatisticFieldName: as }))) });
  const [answer, meta, fresh] = await Promise.all([
    getJson(`${layer}/query?${query}`, `${source.domain}`),
    getJson(`${layer}?f=json`, `${source.domain} metadata`).catch(() => null),
    maxes.length ? getJson(`${layer}/query?${freshQuery}`, `${source.domain} freshness`).catch(() => null) : null,
  ]);
  // A failed query is an HTTP 200 with an error body, and the message is generic.
  if (answer?.error || !Array.isArray(answer?.features)) {
    throw new ApiError(`${source.domain} could not run this connector's query${answer?.error?.message ? ` ("${answer.error.message}")` : ""}. The publisher may have renamed a field or moved the layer. The registry entry needs re-verifying (tests/verify-jurisdiction-sources.mjs); do not trust a workaround.`);
  }

  const drift = [];
  if (meta && !meta.error) {
    if ((meta.copyrightText || null) !== (source.publisher ?? null)) {
      drift.push(`The publisher on the layer now reads "${meta.copyrightText || "(none)"}", but this connector was verified against "${source.publisher ?? "(none)"}". Re-verify before relying on the publisher name.`);
    }
    if ((meta.name ?? null) !== source.dataset_name) drift.push(`The layer is now titled "${meta.name}"; it was verified as "${source.dataset_name}". Layer numbers can be reassigned, so this may be a different table.`);
  } else {
    drift.push("Could not read the layer's metadata, so its publisher and title were not re-checked this time.");
  }

  // Statistic names come back upper-cased; put every row back on the registry's keys.
  const keys = [...source.group_by, ...source.measures.map((m) => m.as)];
  const rows = answer.features.map((f) => {
    const upper = Object.fromEntries(Object.entries(f.attributes || {}).map(([k, v]) => [k.toUpperCase(), v]));
    return Object.fromEntries(keys.map((k) => [k, upper[k.toUpperCase()] ?? null]));
  });
  // The server sorts groups with no amounts first and ignores paging on a statistics
  // query, so sort again with empty values last and cut to the limit here.
  sortRows(rows, source.order_by);

  const stamp = Object.fromEntries(Object.entries(fresh?.features?.[0]?.attributes || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const updated = epochDate(stamp.updated);
  const newest = epochDate(stamp.newest);
  if (source.freshness_column && !updated) drift.push("Could not read when the layer was last modified, so the data's freshness was not re-checked this time.");

  return {
    rows: rows.slice(0, limit),
    more: rows.length > limit || answer.exceededTransferLimit === true,
    drift,
    updated: { data_updated_at: updated, ...(source.newest_column ? { newest_record_date: newest } : {}) },
    notes: [
      ...(answer.exceededTransferLimit === true ? ["The publisher's server cut this answer off at its own maximum number of groups before sorting was finished here, so the biggest rows may be missing. Narrow the filters."] : []),
      ...(updated ? [`The update date is the newest value of the layer's ${source.freshness_column} field${newest ? `; the newest record in the table is dated ${newest}` : ""}.`] : []),
    ],
  };
}

/* -------------------------------------------------------------------- ocpf */
const ocpfBase = (s) => OCPF_OVERRIDE || `https://${s.domain}`;
// "9/30/2026" -> "2026-09-30". Text dates cannot be compared until they are turned round.
const mdyDate = (v) => {
  const m = typeof v === "string" && v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
// How a local filter compares: case, "&" against "and", spacing and a trailing
// "District" are ignored, because the Census and the publisher differ on exactly those.
const plainName = (v) => String(v ?? "").toLowerCase().replace(/&/g, " and ").replace(/\bdistrict\b/g, " ").replace(/\s+/g, " ").trim();

function buildOcpfRequest(source, filters, limit) {
  const params = new URLSearchParams();
  const local = [];
  let year = null;
  for (const [k, v] of Object.entries(filters || {})) {
    const value = filterValue(source, k, v);
    const f = source.filters[k];
    if (f.in === "path") year = value;
    else if (f.type === "local") local.push({ name: k, column: f.column, want: value });
    else params.set(f.param, value);
  }
  // The year is digits only by now, so it is safe as a path segment.
  const query = params.toString();
  return { limit, local, year, path: source.dataset.replace("{year}", year ?? "") + (query ? `?${query}` : "") };
}

async function runOcpf(source, { limit, local, year, path }) {
  const answer = await getJson(`${ocpfBase(source)}${path}`, `${source.domain}`);
  const all = Array.isArray(answer) ? answer : answer?.[source.rows_key];
  if (!Array.isArray(all)) throw new ApiError(`${source.domain} answered without a list of filers, so the publisher has changed how it responds. The registry entry needs re-verifying (tests/verify-jurisdiction-sources.mjs).`);

  const drift = [];
  const alerts = [];
  if (all.length) {
    const gone = source.select.filter((c) => !(c in all[0]));
    if (gone.length) throw new ApiError(`${source.domain} no longer sends ${gone.join(", ")}, so the publisher has changed this list. The registry entry needs re-verifying (tests/verify-jurisdiction-sources.mjs); do not trust a workaround.`);
    const notNumbers = (source.numeric || []).filter((c) => all[0][c] !== null && typeof all[0][c] !== "number");
    if (notNumbers.length) drift.push(`The publisher no longer sends these as numbers: ${notNumbers.join(", ")}. Re-verify before relying on the totals.`);
  } else {
    alerts.push(`The publisher sent an empty list for ${year}. It does that for a year with no reports, for a year it does not hold, and for an address that no longer exists, so this is not proof that nobody filed.`);
  }

  // Turn the dates round first, so "newest" means newest and not last in the alphabet.
  const rows = all.map((r) => ({ ...r, ...Object.fromEntries((source.dates_mdy || []).map((c) => [c, mdyDate(r[c]) ?? r[c]])) }));
  const newest = source.newest_column ? rows.map((r) => r[source.newest_column]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "")).sort().pop() ?? null : null;

  let kept = rows;
  const extra = {};
  for (const f of local) {
    const before = kept;
    kept = kept.filter((r) => plainName(r[f.column]) === plainName(f.want));
    if (!kept.length && before.length) {
      // Say what the publisher does call things, so the next try can use its spelling.
      extra[`${f.name}_values_in_this_answer`] = [...new Set(before.map((r) => r[f.column]).filter(Boolean))].sort().slice(0, 300);
      alerts.push(`Nothing in this answer has ${f.name} "${f.want}". The values the publisher did send are listed in ${f.name}_values_in_this_answer; pick from those and ask again. A place or district missing from the list has no filers in this list for ${year}.`);
    }
  }
  sortRows(kept, source.order_by);

  return {
    rows: kept.slice(0, limit),
    more: kept.length > limit,
    drift,
    updated: { data_updated_at: null, newest_report_date: newest, filers_in_answer: all.length, ...extra },
    alerts,
    notes: [
      newest
        ? `This publisher does not say when the list was last refreshed. The newest reporting period in it ends ${newest}.`
        : "This publisher does not say when the list was last refreshed.",
      `This publisher sends no credit with the data. The credit shown was read from ${source.dataset_url} on ${REGISTRY.verified_on} and was not re-checked on this call.`,
    ],
  };
}

// One entry per publishing platform. prepare() validates the filters and builds the
// request without sending anything; run() sends it and reports what it could re-check.
const PLATFORMS = {
  socrata: { prepare: buildQuery, run: runSocrata },
  carto: { prepare: buildCartoSql, run: runCarto },
  arcgis: { prepare: buildArcgisQuery, run: runArcgis },
  ocpf: { prepare: buildOcpfRequest, run: runOcpf },
};

async function raceTotals({ source_id, filters = {}, limit = 20 }) {
  const source = SOURCES.get(source_id);
  if (!source) throw new ApiError(`Unknown source "${source_id}". Known: ${[...SOURCES.keys()].join(", ")}. jx_sources lists them.`);
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const platform = PLATFORMS[source.platform || "socrata"];
  const request = platform.prepare(source, filters, n); // validates before any request
  if (source.cycle_filter_required && !Object.hasOwn(filters, source.cycle_filter)) {
    throw new ApiError(`This source needs a "${source.cycle_filter}" filter. ${source.cycle_filter_reason || "It cannot be asked without one."} Set ${source.cycle_filter} to the cycle the user cares about.`);
  }
  const { rows, drift, updated, notes: platformNotes, alerts = [], more } = await platform.run(source, request);

  // An unfiltered query returns the biggest rows first, and the biggest are
  // usually old cycles. Say so, naming the range actually returned, instead of
  // letting a 2016 campaign read as this year's race.
  const shaped = shapeRows(source, rows);
  const cycleNotes = [];
  if (source.cycle_filter && !(source.cycle_filter in filters)) {
    const cycleColumn = source.filters[source.cycle_filter]?.column || source.cycle_filter;
    const seen = [...new Set(shaped.map((r) => r[cycleColumn]).filter((v) => v != null))].sort();
    cycleNotes.push(
      seen.length > 1
        ? `No ${source.cycle_filter} filter was set, so these rows mix periods (${seen[0]} to ${seen[seen.length - 1]}) and the biggest are often old. Set ${source.cycle_filter} to the cycle the user cares about before drawing conclusions.`
        : `No ${source.cycle_filter} filter was set, so this covers every period in the dataset, not just the current one. Set ${source.cycle_filter} to the cycle the user cares about.`
    );
  }

  return {
    source: sourceCard(source),
    filters_applied: filters,
    returned: rows.length,
    ...((more ?? rows.length === n) ? { may_be_more: true } : {}),
    rows: shaped,
    ...updated,
    ...(drift.length ? { registry_drift: drift } : {}),
    notes: [
      ...alerts,
      ...cycleNotes,
      source.terms.condition
        ? `The publisher attaches a condition to this data, read on ${source.terms.read_on} at ${source.terms.source}: "${source.terms.condition}" Repeat it to the user; do not interpret whether their use is allowed.`
        : `The publisher's terms were read on ${source.terms.read_on} (${source.terms.source}): ${source.terms.summary}`,
      ...source.notes,
      ...platformNotes,
      "These are totals only. Totals are as filed with the publisher, not audited, and the data lags the filing deadlines.",
      source.publisher_is_agency === false ? `Credited in the dataset's own record to "${source.publisher}", which is a city or portal credit and not an agency.` : `Data published by ${source.publisher}.`,
    ],
  };
}

/* ------------------------------------------------------------------- tools */
const TOOLS = [
  {
    name: "jx_status",
    description:
      "Check this connection without calling anything. It needs no key. Reports how many state and local data sources are connected and when they were last verified. Use it first, or when a call fails.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      platform: SERVER_NAME,
      connection: "configured",
      needs_key: false,
      missing: [],
      connected_sources: REGISTRY.sources.length,
      sources_verified_on: REGISTRY.verified_on,
      coverage: [...new Set(REGISTRY.sources.map((s) => (s.match.place ? `${s.match.place.replace(/[\^$]/g, "")}, ${s.match.state}` : s.match.state)))],
      note: "Most states and cities are not connected. That is expected: jx_locate still returns the geography and search help for them.",
      next_step: "Call jx_sources to see exactly what is connected, or jx_locate with a street address.",
    }),
  },
  {
    name: "jx_locate",
    description:
      "Turn a street address into the districts it sits in (state, county, city, school district, congressional district, state senate and house districts), then say which connected state or local data sources apply, or that none do and how to find the regulator. Also names the federal race, for a separate federal (FEC) connector if one is connected. Needs a full street address; a ZIP is rejected because it can span districts. The address goes to the US Census Bureau and is not stored or repeated; a candidate's home address is sensitive, so prefer a campaign office or other public address.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "A street address, e.g. '301 W 2nd St, Austin, TX 78701'." } },
      required: ["address"],
    },
    handler: async ({ address }) => {
      const r = await locate(address);
      if (!r.matched) return r;
      const geo = r.geo;
      const state = geo.state?.abbr;
      const hits = REGISTRY.sources.filter((s) => matches(s, { state, place: geo.place?.name }));
      const vars = templateVars(geo);
      const federal = geo.congressional_district && state
        ? {
            office: "house",
            state,
            district: geo.congressional_district.number,
            use_with: "A federal (FEC) connector, if one is connected. Tools named fec_race_money, fec_outside_spending and fec_recent_outside_spending take these three values. This server has no federal data.",
            note: "Federal data only. It says nothing about state or local races.",
          }
        : null;
      return {
        matched: true,
        geography: geo,
        vintage_note: "Layer names are as the Census Bureau returned them, vintage included. District lines can change between cycles.",
        federal_race: federal,
        connected_sources: hits.map((s) => ({ ...sourceCard(s), suggested_calls: suggestedCalls(s, vars) })),
        connected: hits.length > 0,
        ...(hits.length ? {} : {
          not_connected: `No connected source covers ${geo.place?.name ? geo.place.name + ", " : ""}${geo.state?.name ?? "this state"}. That is the normal case, not an error.`,
          how_to_find: howToFind(geo),
        }),
        cannot_cover: CANNOT_COVER,
        ask_the_user: "Which office is the campaign running for? State, county, city and school board races can file with different bodies, and a connected source may cover only some of them (see each source's covers).",
      };
    },
  },
  {
    name: "jx_sources",
    description:
      "List the state and local campaign-finance data sources this connector can query, optionally for one state (and city). With no state it lists everything connected, which is a short list. For a state with nothing connected it says so and gives search queries to find the regulator. Use jx_locate when you have an address.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Two-letter state abbreviation, e.g. WA. Omit to list everything connected." },
        place: { type: "string", description: "Optional city name as the Census writes it, e.g. 'Austin city'. Some sources only apply to one city." },
      },
    },
    handler: async ({ state, place }) => {
      if (!state) {
        return {
          connected_sources: REGISTRY.sources.map((s) => ({ ...sourceCard(s), applies_to: s.match.place ? `${s.match.place.replace(/[\^$]/g, "")}, ${s.match.state}` : s.match.state })),
          verified_on: REGISTRY.verified_on,
          everywhere_else: "Not connected. Use jx_locate for the geography and search help, then find the regulator on its official site.",
        };
      }
      const st = String(state).trim().toUpperCase();
      if (!STATES[st]) throw new ApiError(`"${state}" is not a two-letter state abbreviation (for example WA).`);
      const hits = REGISTRY.sources.filter((s) => matches(s, { state: st, place }));
      const placeOnly = REGISTRY.sources.filter((s) => s.match.state === st && s.match.place && !hits.includes(s));
      if (hits.length) return { state: st, connected: true, connected_sources: hits.map(sourceCard) };
      return {
        state: st,
        connected: false,
        not_connected: `No connected source covers ${STATES[st]}${place ? ` / ${place}` : ""}. That is the normal case, not an error.`,
        ...(placeOnly.length ? { connected_for_other_places_in_this_state: placeOnly.map((s) => ({ id: s.id, applies_to: s.match.place.replace(/[\^$]/g, "") })) } : {}),
        how_to_find: howToFind({ state: { abbr: st, name: STATES[st] }, place: place ? { name: place, kind: "incorporated place" } : null }),
      };
    },
  },
  {
    name: "jx_race_totals",
    description:
      "Totals from one connected state or local source: who has raised and spent in the races you filter to, biggest first. Aggregates only (candidates and committees, never individual donors); you cannot write queries, only set the filters a source allows. Use the suggested_calls from jx_locate to start. The result names the publisher, the dataset, the date it was verified and when its data was last updated. Filter values must match the publisher's own spelling.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: { type: "string", description: "A source id from jx_sources or jx_locate, e.g. wa-pdc-summary." },
        filters: { type: "object", description: "Exact-match filters this source allows (see its filters list), e.g. {\"election_year\": 2026, \"legislative_district\": \"34\"}.", additionalProperties: { type: ["string", "integer"] } },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Rows to return, biggest first." },
      },
      required: ["source_id"],
    },
    handler: raceTotals,
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/* -------------------------------------------------------------- rpc plumbing */
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => id != null && send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => id != null && send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOL_MAP.get(params?.name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.handler(params.arguments || {});
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return reply(id, {
          content: [{ type: "text", text: err instanceof ApiError ? err.message : `Unexpected error: ${err?.message || err}` }],
          isError: true,
        });
      }
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
// Drain in-flight requests before exiting. Closing stdin must not kill a call
// that is mid-flight, or the client silently never receives its response.
let pending = 0;
let stdinEnded = false;
function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    pending++;
    Promise.resolve(handle(msg))
      .catch((err) => replyError(msg?.id, -32603, String(err?.message || err)))
      .finally(() => {
        pending--;
        maybeExit();
      });
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});
