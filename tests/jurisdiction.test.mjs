// Tests for the jurisdiction MCP server. Run with:  node --test tests/*.test.mjs
//
// They test what the code computes: parsing, the fixed queries, the guards and
// the protocol. They need no key and make no network calls. Every publisher is
// replaced by a local stand-in that serves responses recorded from the real one
// (tests/fixtures/jurisdiction). To check the registry against the live
// publishers, run tests/verify-jurisdiction-sources.mjs instead.

import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { callTool, listTools, rpc, fixture } from "./helpers.mjs";

/* ------------------------------------------------------------ protocol ---- */

test("the server completes the handshake, sends its rules and advertises its four tools", async () => {
  const { init, tools } = await listTools("jurisdiction");
  assert.equal(init.serverInfo.name, "jurisdiction");
  assert.equal(init.protocolVersion, "2024-11-05");
  assert.match(init.instructions, /never individual donors/);
  assert.match(init.instructions, /Do not name a regulator/);
  assert.deepEqual(tools.map((t) => t.name), ["jx_status", "jx_locate", "jx_sources", "jx_race_totals"]);
  for (const t of tools) {
    assert.ok(t.description.length > 40, `${t.name}: description too thin to steer a model`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("an unknown tool is refused rather than ignored", async () => {
  const { messages } = await rpc("jurisdiction", [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "not_a_tool", arguments: {} } }]);
  assert.ok(messages.find((m) => m.id === 1)?.error, "expected a JSON-RPC error for an unknown tool");
});

/* ------------------------------------------------------- jurisdiction ---- */

// Census, Socrata and Carto stand-ins serving responses recorded on 2026-10-04
// and 2026-10-05 (tests/fixtures/jurisdiction). The geocoder fixtures are public
// buildings.
const jxf = (name) => JSON.parse(fs.readFileSync(fixture(`jurisdiction/${name}`), "utf8"));
const JX_VIEWS = { "3h9x-7bvm": "wa", "jexd-xbcg": "hi", "m3tj-a2pb": "nyc", "3kfv-biw6": "austin" };
const DC_LAYER = "/dcgis/rest/services/DCGIS_DATA/Public_Service_WebMercator/MapServer/34";
const OCPF_FIXTURES = {
  "/reports/mayoral/depository/2025": "ocpf_mayoral_2025_onballot.json",
  "/reports/legislative/race/depository/2026": "ocpf_legislative_2026_senate.json",
  "/reports/cc/ytd/2025": "ocpf_council_2025_first30.json", // first 30 rows of 546, as the server sent them
  "/reports/pacs/2026": "ocpf_pacs_2026_first30.json", // first 30 rows of 255
};
function mockJx({ census, views, carto, arcgis, ocpf } = {}) {
  const seen = [];
  const byAddress = [
    [/260 Broadway/, "census_nyc_city_hall.json"],
    [/4600 Silver Hill/, "census_census_hq.json"],
    [/301 W 2nd/, "census_austin_city_hall.json"],
    [/530 S King/, "census_honolulu_hale.json"],
    [/600 4th Ave/, "census_seattle_city_hall.json"],
    [/1400 John F Kennedy/, "census_philadelphia_city_hall.json"],
    [/1350 Pennsylvania/, "census_dc_wilson_building.json"],
    [/24 Beacon/, "census_ma_state_house.json"],
  ];
  const rows = {
    "3h9x-7bvm": "socrata_wa_summary.json",
    "jexd-xbcg": "socrata_hi_grouped.json",
    "m3tj-a2pb": "socrata_nyc_analysis.json",
    "3kfv-biw6": "socrata_austin_grouped.json",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    res.setHeader("Content-Type", "application/json");
    let m;
    if (url.pathname === "/geocoder/geographies/onelineaddress") {
      if (census) {
        res.statusCode = census.status;
        return res.end(JSON.stringify(census.body ?? {}));
      }
      const addr = url.searchParams.get("address");
      const hit = byAddress.find(([re]) => re.test(addr));
      return res.end(JSON.stringify(hit ? jxf(hit[1]) : { result: { addressMatches: [] } }));
    }
    if ((m = url.pathname.match(/^\/resource\/([\w-]+)\.json$/)) && rows[m[1]]) return res.end(JSON.stringify(jxf(rows[m[1]])));
    if ((m = url.pathname.match(/^\/api\/views\/([\w-]+)\.json$/)) && JX_VIEWS[m[1]]) {
      const v = jxf("socrata_views.json")[JX_VIEWS[m[1]]];
      return res.end(JSON.stringify(views ? views(v) : v));
    }
    if (url.pathname === "/api/v2/sql") {
      const sql = url.searchParams.get("q") || "";
      const recorded = jxf(/^SELECT max\(/.test(sql) ? "carto_phl_freshness.json" : "carto_phl_summary.json");
      const answer = carto ? carto({ sql, body: recorded }) : { body: recorded };
      res.statusCode = answer.status || 200;
      return res.end(JSON.stringify(answer.body));
    }
    if (url.pathname.startsWith("/reports/")) {
      // Like the real server: a year or path it does not hold is a 200 with an empty list.
      const recorded = OCPF_FIXTURES[url.pathname] ? jxf(OCPF_FIXTURES[url.pathname]) : [];
      const answer = ocpf ? ocpf({ path: url.pathname, body: recorded }) : { body: recorded };
      res.statusCode = answer.status || 200;
      return res.end(JSON.stringify(answer.body));
    }
    if (url.pathname === DC_LAYER || url.pathname === `${DC_LAYER}/query`) {
      const kind = url.pathname === DC_LAYER ? "layer" : /"max"/.test(url.searchParams.get("outStatistics") || "") ? "freshness" : "grouped";
      const recorded = jxf(`arcgis_dc_${kind}.json`);
      const answer = arcgis ? arcgis({ kind, body: recorded }) : { body: recorded };
      res.statusCode = answer.status || 200;
      return res.end(JSON.stringify(answer.body));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ census: `http://127.0.0.1:${port}/geocoder`, socrata: `http://127.0.0.1:${port}`, carto: `http://127.0.0.1:${port}`, arcgis: `http://127.0.0.1:${port}`, ocpf: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    })
  );
}
async function withJx(fn, opts) {
  const mock = await mockJx(opts);
  try {
    return await fn((tool, args) => callTool("jurisdiction", tool, args, { env: { JX_CENSUS_BASE: mock.census, JX_SOCRATA_BASE: mock.socrata, JX_CARTO_BASE: mock.carto, JX_ARCGIS_BASE: mock.arcgis, JX_OCPF_BASE: mock.ocpf } }), mock);
  } finally {
    mock.close();
  }
}

test("jurisdiction status needs no key and makes no request", async () => {
  const r = await callTool("jurisdiction", "jx_status", {}, { env: { JX_CENSUS_BASE: "http://127.0.0.1:9", JX_SOCRATA_BASE: "http://127.0.0.1:9", JX_CARTO_BASE: "http://127.0.0.1:9", JX_ARCGIS_BASE: "http://127.0.0.1:9", JX_OCPF_BASE: "http://127.0.0.1:9" } });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.connection, "configured");
  assert.equal(r.json.needs_key, false);
  assert.equal(r.json.connected_sources, 10);
  assert.ok(r.json.coverage.includes("MA"));
  assert.ok(r.json.coverage.includes("Philadelphia city, PA"));
  assert.ok(r.json.coverage.includes("DC"));
  assert.match(r.json.note, /Most states and cities are not connected/);
});

test("locate: NYC address gives the districts, the federal race, and the one city source that applies", async () => {
  await withJx(async (call, mock) => {
    const r = await call("jx_locate", { address: "260 Broadway, New York, NY 10007" });
    assert.ok(!r.isError, r.text);
    const j = r.json;
    assert.equal(j.geography.state.abbr, "NY");
    assert.equal(j.geography.place.name, "New York city");
    assert.equal(j.geography.place.kind, "incorporated place");
    assert.equal(j.geography.congressional_district.number, "10");
    assert.match(j.geography.congressional_district.layer, /Congressional Districts$/, "the vintage label is passed through as returned");
    assert.match(j.geography.state_senate_district.name, /27/);
    assert.equal(j.geography.school_districts[0].name, "New York City Department Of Education");
    assert.deepEqual({ office: j.federal_race.office, state: j.federal_race.state, district: j.federal_race.district }, { office: "house", state: "NY", district: "10" });
    assert.deepEqual(j.connected_sources.map((s) => s.id), ["nyc-cfb-analysis"], "the NYC source applies; nothing for the rest of the state is claimed");
    assert.equal(j.connected, true);
    assert.ok(j.cannot_cover.some((c) => /council wards/.test(c)), "the geocoder's blind spots must be stated");
    assert.doesNotMatch(r.text, /260 Broadway/, "the street address must not be echoed back");
    assert.equal(mock.seen.length, 1, "one Census call, nothing else");
  });
});

test("locate: an unconnected state returns geography and search help, and names no agency", async () => {
  await withJx(async (call) => {
    const r = await call("jx_locate", { address: "4600 Silver Hill Rd, Washington, DC 20233" });
    assert.ok(!r.isError, r.text);
    const j = r.json;
    assert.equal(j.geography.state.abbr, "MD");
    assert.equal(j.geography.place.kind, "census designated place (not a municipality)");
    assert.equal(j.geography.congressional_district.number, "04");
    assert.equal(j.connected, false);
    assert.deepEqual(j.connected_sources, []);
    assert.match(j.not_connected, /normal case, not an error/);
    assert.ok(j.how_to_find.search_queries.includes("Maryland campaign finance disclosure search"));
    assert.ok(j.how_to_find.search_queries.some((q) => /Prince George's County/.test(q)), "the county the geocoder returned drives a local search");
    assert.match(j.how_to_find.steps.join(" "), /Do not name the regulator/);
    assert.doesNotMatch(r.text, /Board of Elections|Ethics Commission|State Board|Fair Election|Campaign Finance Board of/i, "an agency name that did not come from fetched data must never appear");
  });
});

test("locate: Seattle suggests calls with the district's leading zeros stripped and the county in the publisher's case", async () => {
  await withJx(async (call) => {
    const r = await call("jx_locate", { address: "600 4th Ave, Seattle, WA 98104" });
    const wa = r.json.connected_sources.find((s) => s.id === "wa-pdc-summary");
    assert.ok(wa);
    assert.equal(wa.publisher, "Public Disclosure Commission");
    assert.equal(wa.verified_on, "2026-10-05");
    const year = String(new Date().getFullYear());
    const byLabel = Object.fromEntries(wa.suggested_calls.map((c) => [c.label, c.arguments]));
    assert.deepEqual(byLabel["State legislative district races"], { source_id: "wa-pdc-summary", filters: { election_year: year, legislative_district: "34" } }, "Census says 034; the dataset says 34");
    assert.deepEqual(byLabel["Everything filed in this county"].filters.jurisdiction_county, "KING");
  });
});

test("locate: a place-limited source applies to its city only", async () => {
  await withJx(async (call) => {
    const austin = await call("jx_locate", { address: "301 W 2nd St, Austin, TX 78701" });
    assert.deepEqual(austin.json.connected_sources.map((s) => s.id), ["austin-contributions"]);
    const src = await call("jx_sources", { state: "TX" });
    assert.equal(src.json.connected, false, "Texas as a whole is not connected, only Austin");
    assert.deepEqual(src.json.connected_for_other_places_in_this_state.map((s) => s.id), ["austin-contributions"]);
    const hi = await call("jx_locate", { address: "530 S King St, Honolulu, HI 96813" });
    const h = hi.json.connected_sources.find((s) => s.id === "hi-csc-contributions");
    assert.deepEqual(h.suggested_calls[0].arguments.filters, { county: "Honolulu" }, "'Honolulu County' becomes the dataset's 'Honolulu'");
  });
});

test("locate: a source with no named agency says so instead of guessing one", async () => {
  await withJx(async (call) => {
    const r = await call("jx_locate", { address: "301 W 2nd St, Austin, TX 78701" });
    const a = r.json.connected_sources[0];
    assert.equal(a.publisher, "City of Austin, Texas - data.austintexas.gov", "the credit is passed through exactly as the metadata reads");
    assert.match(a.publisher_note, /not a specific agency/);
    const t = await call("jx_race_totals", { source_id: "austin-contributions", filters: { contribution_year: "2025" } });
    assert.equal(t.json.registry_drift, undefined, "a verbatim credit must not read as drift");
    assert.ok(t.json.notes.some((n) => /portal credit and not an agency/.test(n)));
    assert.ok(t.json.notes.some((n) => /credit field names the city's open-data portal, not an agency, but the record's Ownership field names the Austin City Clerk's Office/.test(n)), "the credit and the ownership field are both reported, as the record has them");
    assert.ok(t.json.notes.some((n) => /Confirm the responsible office/.test(n)));
  });
});

test("locate input guards: a ZIP, junk, and no match, with no wasted request", async () => {
  await withJx(async (call, mock) => {
    assert.match((await call("jx_locate", { address: "98104" })).text, /ZIP code is not enough/);
    assert.match((await call("jx_locate", { address: "Seattle" })).text, /does not look like a street address/);
    assert.match((await call("jx_locate", { address: "" })).text, /Give a street address/);
    assert.equal(mock.seen.length, 0, "bad input must not reach the Census Bureau");
    const none = await call("jx_locate", { address: "99999 Nowhere Ln, Nowhere, ZZ 00000" });
    assert.ok(!none.isError, "no match is an answer, not a failure");
    assert.equal(none.json.matched, false);
    assert.match(none.json.message, /found no match/);
  });
});

test("locate: a Census outage is explained plainly", async () => {
  await withJx(async (call) => {
    const r = await call("jx_locate", { address: "260 Broadway, New York, NY 10007" });
    assert.ok(r.isError);
    assert.match(r.text, /the Census geocoder returned 503/);
  }, { census: { status: 503, body: { error: "down" } } });
});

test("race totals: rows are fixed-column, numbers are numbers, and the source is named from its metadata", async () => {
  await withJx(async (call, mock) => {
    const r = await call("jx_race_totals", { source_id: "wa-pdc-summary", filters: { election_year: 2026, legislative_district: "43" }, limit: 5 });
    assert.ok(!r.isError, r.text);
    const j = r.json;
    assert.equal(j.rows[0].contributions_amount, 544625.81, "Socrata sends numbers as strings; they must come back as numbers");
    assert.equal(j.source.publisher, "Public Disclosure Commission");
    assert.equal(j.source.dataset_url, "https://data.wa.gov/d/3h9x-7bvm");
    assert.equal(j.source.verified_on, "2026-10-05");
    assert.equal(j.data_updated_at, new Date(jxf("socrata_views.json").wa.rowsUpdatedAt * 1000).toISOString().slice(0, 10));
    assert.equal(j.registry_drift, undefined);
    const wanted = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../servers/jurisdiction/sources.json", import.meta.url)), "utf8")).sources[0].select;
    for (const row of j.rows) assert.deepEqual(Object.keys(row), wanted, "every row has every column, in order, with null where the publisher sent nothing");
    assert.ok(j.rows.some((r) => Object.values(r).includes(null)), "the recorded data really does contain missing fields, so this checks something");
    const q = mock.seen.find((s) => s.path === "/resource/3h9x-7bvm.json").query;
    assert.equal(q.election_year, "2026");
    assert.equal(q.legislative_district, "43");
    assert.equal(q.$limit, "5");
    assert.doesNotMatch(q.$select, /contributor|donor|employer|occupation|address|phone|email|treasurer/i, "the select list is fixed and holds no person-level column");
    assert.equal(Object.keys(q).filter((k) => k.startsWith("$")).sort().join(), "$limit,$order,$select");
  });
});

test("race totals: grouped sources sum in the query, not in the model", async () => {
  await withJx(async (call, mock) => {
    const r = await call("jx_race_totals", { source_id: "hi-csc-contributions", filters: { county: "Honolulu" } });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.rows[0].total, 2279118.09);
    assert.equal(r.json.rows[0].gifts, 1052);
    const q = mock.seen.find((s) => s.path === "/resource/jexd-xbcg.json").query;
    assert.match(q.$select, /sum\(amount\) as total,count\(\*\) as gifts/);
    assert.equal(q.$group, "candidate_name,office,county,district,party,election_period");
    assert.doesNotMatch(r.text, /contributor|street_address|employer/i);
  });
});

test("race totals: an unfiltered query warns that old cycles are mixed in, and a filtered one does not", async () => {
  await withJx(async (call) => {
    const hi = await call("jx_race_totals", { source_id: "hi-csc-contributions" });
    assert.match(hi.json.notes[0], /No election_period filter was set.*2016-2020 to 2020-2024.*the biggest are often old/, "the range actually returned is named");
    const nyc = await call("jx_race_totals", { source_id: "nyc-cfb-analysis" });
    assert.match(nyc.json.notes[0], /el_cycle.*2001 to 2009/);
    const au = await call("jx_race_totals", { source_id: "austin-contributions" });
    assert.match(au.json.notes[0], /contribution_year filter was set, so this covers every period/, "a source that doesn't return the cycle column still gets a warning");
    const wa = await call("jx_race_totals", { source_id: "wa-pdc-summary", filters: { election_year: 2026 } });
    assert.doesNotMatch(wa.json.notes.join(" "), /filter was set/, "no warning once the cycle is pinned");
  });
});

test("race totals: filters cannot be turned into a query for individual donors", async () => {
  await withJx(async (call, mock) => {
    const bad = [
      { election_year: "2026 OR 1=1" },
      { office: "x' OR contributor_name='y" },
      { legislative_district: "43&$select=contributor_name" },
      { $where: "1=1" },
      { contributor_name: "anyone" },
      { $select: "contributor_name" },
    ];
    for (const filters of bad) {
      const r = await call("jx_race_totals", { source_id: "wa-pdc-summary", filters });
      assert.ok(r.isError, `accepted ${JSON.stringify(filters)}`);
    }
    assert.equal(mock.seen.length, 0, "every one must be refused before a request is sent");
    assert.match((await call("jx_race_totals", { source_id: "nope" })).text, /Unknown source/);
  });
});

test("race totals: a changed publisher or title is flagged, not silently trusted", async () => {
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "wa-pdc-summary", filters: { election_year: 2026 } });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.registry_drift.length, 2);
    assert.match(r.json.registry_drift[0], /now reads "Somebody Else"/);
    assert.match(r.json.registry_drift[1], /now titled "Renamed"/);
  }, { views: (v) => ({ ...v, attribution: "Somebody Else", name: "Renamed" }) });
});

test("a registry entry that selects a person-level column stops the server from starting", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "jx-"));
  const file = path.join(dir, "sources.json");
  const reg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../servers/jurisdiction/sources.json", import.meta.url)), "utf8"));
  reg.sources[0].select.push("contributor_name");
  fs.writeFileSync(file, JSON.stringify(reg));
  const { messages, stderr } = await rpc("jurisdiction", [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], { env: { JX_SOURCES_FILE: file } });
  assert.equal(messages.length, 0, "the server must not answer with a registry it refuses");
  assert.match(stderr, /sources\.json refused.*contributor_name/);
});

test("every registry entry matches the recorded dataset columns and types", () => {
  const views = jxf("socrata_views.json");
  const reg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../servers/jurisdiction/sources.json", import.meta.url)), "utf8"));
  for (const s of reg.sources) {
    if (s.platform === "carto") {
      // Carto has no metadata record; the recorded answer's own field list stands in for it.
      const fields = jxf("carto_phl_summary.json").fields;
      assert.deepEqual(Object.keys(fields), s.select, `${s.id}: the fixture was not recorded with the entry's select list`);
      for (const c of s.numeric || []) assert.equal(fields[c].type, "number", `${s.id}: ${c} is treated as a number but is ${fields[c].type}`);
      for (const c of s.dates || []) assert.equal(fields[c].type, "date", `${s.id}: ${c} is treated as a date but is ${fields[c].type}`);
      for (const f of Object.values(s.filters)) assert.ok(f.column in fields, `${s.id}: filter column ${f.column} is not in the dataset`);
      continue;
    }
    if (s.platform === "ocpf") {
      const file = OCPF_FIXTURES[s.dataset.replace("{year}", s.id === "ma-ocpf-legislative" || s.id === "ma-ocpf-pacs" ? "2026" : "2025")];
      assert.ok(file, `${s.id}: no recorded answer`);
      const body = jxf(file);
      const row = (Array.isArray(body) ? body : body[s.rows_key])[0];
      for (const c of s.select) assert.ok(c in row, `${s.id}: column ${c} is not in the answer`);
      for (const c of s.numeric) assert.equal(typeof row[c], "number", `${s.id}: ${c} is treated as a number`);
      assert.doesNotMatch(Object.keys(row).join(" "), /addr|street|zip|phone|email|employer|occup|contributor|donor/i, `${s.id}: the list itself must hold no donor or contact field`);
      const swagger = jxf("ocpf_swagger_excerpt.json");
      assert.equal(swagger.info.title, s.dataset_name);
      assert.ok(swagger.info.description.includes(s.publisher), `${s.id}: the publisher must be the API description's own words`);
      assert.equal(swagger.info.contact.url, s.publisher_link);
      assert.ok(swagger.paths[s.dataset], `${s.id}: the API description does not list ${s.dataset}`);
      continue;
    }
    if (s.platform === "arcgis") {
      const layer = jxf("arcgis_dc_layer.json");
      const type = Object.fromEntries(layer.fields.map((f) => [f.name, f.type]));
      const used = [...s.group_by, ...s.measures.map((m) => m.column).filter(Boolean), ...Object.values(s.filters).map((f) => f.column), s.count_field, s.freshness_column, s.newest_column];
      for (const c of used) assert.ok(c in type, `${s.id}: column ${c} is not in the layer`);
      for (const m of s.measures.filter((x) => x.fn === "sum")) assert.match(type[m.column], /Integer|Double|Single/, `${s.id}: ${m.column} is summed but is ${type[m.column]}`);
      assert.equal(layer.copyrightText, s.publisher, `${s.id}: publisher in the registry differs from the layer's own copyright text`);
      assert.equal(layer.name, s.dataset_name, `${s.id}: layer name`);
      assert.equal(layer.supportsStatistics, true);
      continue;
    }
    const v = views[JX_VIEWS[s.dataset]];
    assert.ok(v, `${s.id}: no recorded metadata`);
    const type = Object.fromEntries(v.columns.map((c) => [c.fieldName, c.dataTypeName]));
    const used = [...(s.select || []), ...(s.group_by || []), ...(s.measures || []).map((m) => m.column).filter(Boolean), ...Object.values(s.filters).map((f) => f.column)];
    for (const c of used) assert.ok(c in type, `${s.id}: column ${c} is not in the dataset`);
    for (const c of [...(s.numeric || []), ...(s.measures || []).filter((m) => m.fn === "sum").map((m) => m.column)]) {
      assert.equal(type[c], "number", `${s.id}: ${c} is summed but is ${type[c]}`);
    }
    assert.equal(v.attribution, s.publisher, `${s.id}: publisher in the registry differs from the dataset's own attribution`);
    assert.equal(v.name === s.dataset_name || v.name.startsWith(s.dataset_name), true, `${s.id}: dataset name`);
  }
});

/* -- jurisdiction on Carto (Philadelphia). Carto takes one SQL string, so these
      tests are mostly about what can and cannot reach that string. -- */
const PHL_SELECT = "filer_name, filer_candidate_name, filer_type, candidate_office, office_level, candidate_district_num, candidate_party, report_year, total_contributions, total_expenditures, ending_cash_balance, ending_unpaid_debts, num_paper_filings, last_report_date";
const PHL_FILERS = "filer_type IN ('Candidate Committee', 'Individual_Candidate', 'Other PAC', 'Union', 'Ward', 'Political Party Committee')";
const cartoSql = (mock) => mock.seen.filter((s) => s.path === "/api/v2/sql").map((s) => s.query.q);

test("locate: Philadelphia City Hall finds the city source, credited to the city and not to an agency", async () => {
  await withJx(async (call) => {
    const r = await call("jx_locate", { address: "1400 John F Kennedy Blvd, Philadelphia, PA 19107" });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.geography.place.name, "Philadelphia city");
    assert.deepEqual(r.json.connected_sources.map((s) => s.id), ["phl-campfin-summary"]);
    const s = r.json.connected_sources[0];
    assert.equal(s.publisher, "City of Philadelphia", "the credit is the catalogue's own words");
    assert.match(s.publisher_note, /not a specific agency/);
    assert.equal(s.dataset_url, "https://opendataphilly.org/datasets/campaign-finance-reports/");
    assert.match(s.filters.candidate_office, /^one of: Mayor \| City Council \|/, "an enum filter lists what it accepts");
    assert.deepEqual(s.suggested_calls.map((c) => c.arguments.filters), [{ report_year: String(new Date().getFullYear()), filer_type: "Candidate Committee" }, { report_year: String(new Date().getFullYear()) }]);
    const pa = await call("jx_sources", { state: "PA" });
    assert.equal(pa.json.connected, false, "Pennsylvania as a whole is not connected, only Philadelphia");
    assert.deepEqual(pa.json.connected_for_other_places_in_this_state.map((x) => x.id), ["phl-campfin-summary"]);
  });
});

test("carto race totals: the SQL is built from the registry, and the result says what could not be re-checked", async () => {
  await withJx(async (call, mock) => {
    const r = await call("jx_race_totals", { source_id: "phl-campfin-summary", filters: { report_year: 2023, candidate_office: "mayor" }, limit: 6 });
    assert.ok(!r.isError, r.text);
    const j = r.json;
    const [main, fresh] = [cartoSql(mock).find((q) => !/^SELECT max/.test(q)), cartoSql(mock).find((q) => /^SELECT max/.test(q))];
    assert.equal(main, `SELECT ${PHL_SELECT} FROM campfin_summary WHERE ${PHL_FILERS} AND report_year = 2023 AND candidate_office = 'Mayor' ORDER BY total_contributions DESC NULLS LAST LIMIT 6`, "the caller typed 'mayor'; the SQL carries the registry's 'Mayor'");
    assert.equal(fresh, "SELECT max(last_report_date) AS latest FROM campfin_summary");
    assert.equal(cartoSql(mock).length, 2, "one totals query and one freshness query, nothing else");
    assert.doesNotMatch(main, /entity|employer|occupation|address|zip|campfin_(transactions|contributions|expenditures)/i, "no person-level column and no transaction table");

    assert.equal(j.returned, 6);
    assert.equal(j.rows[0].total_contributions, 12632320.62);
    assert.equal(j.rows[0].report_year, 2023);
    assert.equal(j.rows[0].last_report_date, "2023-12-31", "a timestamp is cut to its date");
    assert.deepEqual(Object.keys(j.rows[0]), PHL_SELECT.split(", "));
    assert.ok(j.rows.some((row) => row.candidate_district_num === null), "the recorded data has missing fields, kept as null");
    assert.equal(j.data_updated_at, null, "Carto does not say when the table was refreshed, so no date is claimed");
    assert.equal(j.newest_report_date, "2026-09-14");
    assert.equal(j.registry_drift, undefined);
    const notes = j.notes.join(" ");
    assert.match(notes, /does not say when the table was last refreshed. The newest report in it is dated 2026-09-14/);
    assert.match(notes, /carries no publisher credit with the data.*was not re-checked on this call/);
    assert.match(notes, /num_paper_filings counts reports the filer submitted on paper/);
    assert.match(notes, /city or portal credit and not an agency/);
    assert.match(notes, /an empty candidate_office does not mean the filer has no race/);
    assert.doesNotMatch(notes, /filter was set/, "no cycle warning once report_year is pinned");
  });
});

test("carto race totals: every query carries the fixed filer-type list, so private individuals and businesses are never returned", async () => {
  await withJx(async (call, mock) => {
    for (const filters of [{}, { report_year: 2026 }, { filer_type: "union" }, { office_level: "local" }]) {
      const r = await call("jx_race_totals", { source_id: "phl-campfin-summary", filters });
      assert.ok(!r.isError, r.text);
    }
    const mains = cartoSql(mock).filter((q) => !/^SELECT max/.test(q));
    assert.equal(mains.length, 4);
    for (const q of mains) assert.ok(q.includes(` WHERE ${PHL_FILERS}`), q);
    assert.ok(mains[2].endsWith(`WHERE ${PHL_FILERS} AND filer_type = 'Union' ORDER BY total_contributions DESC NULLS LAST LIMIT 20`));
    assert.doesNotMatch(mains.join(" "), /Individual_Noncandidate|Business|Uncategorized/);
  });
});

test("carto race totals: a district number is sent as quoted digits, and no year filter earns a warning", async () => {
  await withJx(async (call, mock) => {
    const r = await call("jx_race_totals", { source_id: "phl-campfin-summary", filters: { candidate_office: "City Council", candidate_district_num: "8" } });
    assert.ok(!r.isError, r.text);
    assert.match(cartoSql(mock).find((q) => !/^SELECT max/.test(q)), / AND candidate_office = 'City Council' AND candidate_district_num = '8' ORDER BY/);
    assert.match(r.json.notes[0], /No report_year filter was set/);
  });
});

test("carto race totals: nothing a caller types can reach the SQL as text", async () => {
  await withJx(async (call, mock) => {
    const bad = [
      { candidate_office: "Mayor' OR '1'='1" },
      { candidate_office: "Mayor'; SELECT entity_name FROM campfin_contributions --" },
      { candidate_office: "Dog Catcher" },
      { filer_type: "Individual_Noncandidate" },
      { filer_type: "Business" },
      { office_level: "local' --" },
      { report_year: "2023 OR 1=1" },
      { report_year: "2023; DROP TABLE campfin_summary" },
      { candidate_district_num: "8' OR ''='" },
      { filer_name: "anyone" },
      { entity_name: "anyone" },
      { q: "SELECT * FROM campfin_contributions" },
      { "report_year = 2023 OR 1": "1" },
      JSON.parse('{"__proto__": "x"}'),
      JSON.parse('{"constructor": "x"}'),
    ];
    for (const filters of bad) {
      const r = await call("jx_race_totals", { source_id: "phl-campfin-summary", filters });
      assert.ok(r.isError, `accepted ${JSON.stringify(filters)}`);
    }
    assert.equal(mock.seen.length, 0, "every one must be refused before a request is sent");
    assert.match((await call("jx_race_totals", { source_id: "phl-campfin-summary", filters: { candidate_office: "Dog Catcher" } })).text, /must be one of: Mayor, City Council,/);
  });
});

test("carto race totals: a dropped column, a changed type and a missing freshness answer are all said plainly", async () => {
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "phl-campfin-summary" });
    assert.ok(r.isError);
    assert.match(r.text, /no longer has a column this connector expects.*re-verifying/);
  }, { carto: () => ({ status: 400, body: { error: ['column "total_contributions" does not exist'] } }) });

  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "phl-campfin-summary", filters: { report_year: 2023 } });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.registry_drift.length, 2);
    assert.match(r.json.registry_drift[0], /no longer sends these as numbers: total_contributions/);
    assert.match(r.json.registry_drift[1], /Could not read the newest report date/);
    assert.equal(r.json.newest_report_date, null);
  }, {
    carto: ({ sql, body }) => (/^SELECT max/.test(sql)
      ? { status: 500, body: { error: ["down"] } }
      : { body: { ...body, fields: { ...body.fields, total_contributions: { type: "string" } } } }),
  });
});

test("a carto registry entry with free text, a loose name or a quoted enum value stops the server from starting", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "jx-"));
  const read = () => JSON.parse(fs.readFileSync(fileURLToPath(new URL("../servers/jurisdiction/sources.json", import.meta.url)), "utf8"));
  const phl = (reg) => reg.sources.find((s) => s.id === "phl-campfin-summary");
  const cases = [
    [(s) => (s.filters.candidate_party = { column: "candidate_party", type: "text" }), /may only take integer, enum or present filters.*candidate_party/],
    [(s) => (s.dataset = "campfin_summary; DROP TABLE x"), /is not a plain table or column name/],
    [(s) => s.select.push("*"), /"\*" is not a plain table or column name/],
    [(s) => s.select.push("entity_address_1"), /person-level column "entity_address_1"/],
    [(s) => s.filters.candidate_office.values.push("O'Brien"), /has a value that is not plain text/],
    [(s) => (s.order_by = "total_contributions DESC; SELECT 1"), /order_by must be one column/],
    [(s) => (s.require_in["1=1 OR filer_type"] = ["Union"]), /is not a plain table or column name/],
    [(s) => s.require_in.filer_type.push("x') OR ('1'='1"), /require_in "filer_type" has a value that is not plain text/],
  ];
  for (const [i, [breakIt, expected]] of cases.entries()) {
    const reg = read();
    breakIt(phl(reg));
    const file = path.join(dir, `sources-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(reg));
    const { messages, stderr } = await rpc("jurisdiction", [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], { env: { JX_SOURCES_FILE: file } });
    assert.equal(messages.length, 0, `case ${i}: the server must not answer with a registry it refuses`);
    assert.match(stderr, expected, `case ${i}`);
  }
});

/* -- jurisdiction on ArcGIS (DC). The server does the adding up; this connector
      sends a where clause, so the same "no typed text in SQL" rule applies. -- */
const arcgisSeen = (mock, kind) => mock.seen.filter((s) => (kind === "layer" ? s.path === DC_LAYER : s.path === `${DC_LAYER}/query` && /"max"/.test(s.query.outStatistics) === (kind === "freshness")));

test("locate: a DC address finds the DC source, credited to the agency the layer names, with its required filter", async () => {
  await withJx(async (call) => {
    const r = await call("jx_locate", { address: "1350 Pennsylvania Ave NW, Washington, DC 20004" });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.geography.state.abbr, "DC");
    assert.equal(r.json.geography.congressional_district.name, "Delegate District (at Large)");
    assert.deepEqual(r.json.connected_sources.map((s) => s.id), ["dc-ocf-contributions"]);
    const s = r.json.connected_sources[0];
    assert.equal(s.publisher, "Office of Campaign Finance", "the credit is the layer's own copyright text");
    assert.equal(s.publisher_note, undefined, "an agency credit carries no 'not an agency' note");
    assert.deepEqual(s.required_filters, ["election_year"]);
    assert.deepEqual(s.filters, { election_year: "integer", has_candidate: "yes or no" });
    const year = String(new Date().getFullYear());
    assert.deepEqual(s.suggested_calls.map((c) => c.arguments.filters), [{ election_year: year, has_candidate: "yes" }, { election_year: year }], "every suggested call carries the required year");
  });
});

test("arcgis race totals: the server sums, and the rows come back on the registry's keys, sorted and cut here", async () => {
  await withJx(async (call, mock) => {
    const r = await call("jx_race_totals", { source_id: "dc-ocf-contributions", filters: { election_year: 2026, has_candidate: "YES" }, limit: 5 });
    assert.ok(!r.isError, r.text);
    const j = r.json;
    const q = arcgisSeen(mock, "grouped")[0].query;
    assert.equal(q.where, "ELECTIONYEAR = 2026 AND CANDIDATENAME IS NOT NULL");
    assert.equal(q.groupByFieldsForStatistics, "CANDIDATENAME,COMMITTEENAME,ELECTIONYEAR");
    assert.deepEqual(JSON.parse(q.outStatistics), [
      { statisticType: "sum", onStatisticField: "AMOUNT", outStatisticFieldName: "total" },
      { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "gifts" },
    ]);
    assert.equal(q.orderByFields, "total DESC");
    assert.deepEqual(Object.keys(q).sort(), ["f", "groupByFieldsForStatistics", "orderByFields", "outStatistics", "returnGeometry", "where"], "no outFields: this connector never asks for rows");
    assert.doesNotMatch(JSON.stringify(q), /CONTRIBUTOR|ADDRESS|EMPLOYER|WARD/i);
    assert.equal(mock.seen.length, 3, "one totals query, the layer's metadata and one freshness query");

    const recorded = jxf("arcgis_dc_grouped.json").features.map((f) => f.attributes.TOTAL);
    assert.ok(recorded.length > 5, "the recorded answer has more groups than the limit, so the cut is tested");
    assert.equal(j.returned, 5, "the server ignores paging on a statistics query, so the limit is applied here");
    assert.equal(j.may_be_more, true);
    assert.deepEqual(Object.keys(j.rows[0]), ["CANDIDATENAME", "COMMITTEENAME", "ELECTIONYEAR", "total", "gifts"], "TOTAL and GIFTS come back upper-cased and are put back");
    assert.equal(j.rows[0].total, Math.max(...recorded));
    assert.equal(j.rows[0].ELECTIONYEAR, 2026);
    assert.equal(j.data_updated_at, "2026-10-05");
    assert.equal(j.newest_record_date, "2026-09-28", "a date with no time is midnight UTC and must not slip a day");
    assert.equal(j.registry_drift, undefined);
    assert.equal(j.source.publisher, "Office of Campaign Finance");
    assert.match(j.notes.join(" "), /Data published by Office of Campaign Finance\./);
    assert.match(j.notes.join(" "), /no office field/);
  });
});

test("arcgis race totals: groups with no amounts go last, and a cut-off answer is said plainly", async () => {
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "dc-ocf-contributions", filters: { election_year: 2026 }, limit: 3 });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.returned, 3);
    assert.ok(r.json.rows.every((row) => typeof row.total === "number"), "the empty groups the server put first are not in the top rows");
    assert.ok(r.json.rows[0].total >= r.json.rows[1].total && r.json.rows[1].total >= r.json.rows[2].total);
    assert.equal(r.json.may_be_more, true);
    assert.match(r.json.notes.join(" "), /cut this answer off at its own maximum number of groups/);
  }, {
    arcgis: ({ kind, body }) => (kind === "grouped"
      ? { body: { ...body, exceededTransferLimit: true, features: [{ attributes: { CANDIDATENAME: null, COMMITTEENAME: "Empty Committee One", ELECTIONYEAR: 2026, TOTAL: null, GIFTS: 4 } }, { attributes: { CANDIDATENAME: null, COMMITTEENAME: "Empty Committee Two", ELECTIONYEAR: 2026, TOTAL: null, GIFTS: 1 } }, ...body.features] } }
      : { body }),
  });
});

test("arcgis race totals: the year is required and nothing typed can reach the where clause", async () => {
  await withJx(async (call, mock) => {
    const missing = await call("jx_race_totals", { source_id: "dc-ocf-contributions" });
    assert.ok(missing.isError);
    assert.match(missing.text, /needs a "election_year" filter/);
    assert.ok((await call("jx_race_totals", { source_id: "dc-ocf-contributions", filters: { has_candidate: "yes" } })).isError, "a filter that is not the year does not satisfy the requirement");
    const bad = [
      { election_year: "2026 OR 1=1" },
      { election_year: "2026; DROP TABLE x" },
      { election_year: 2026, has_candidate: "yes OR 1=1" },
      { election_year: 2026, has_candidate: "maybe" },
      { election_year: 2026, CONTRIBUTORNAME: "anyone" },
      { election_year: 2026, WARD: "2" },
      { election_year: 2026, where: "1=1" },
      { election_year: 2026, outFields: "*" },
      { election_year: 2026, "ELECTIONYEAR = 2026 OR 1": "1" },
    ];
    for (const filters of bad) {
      const r = await call("jx_race_totals", { source_id: "dc-ocf-contributions", filters });
      assert.ok(r.isError, `accepted ${JSON.stringify(filters)}`);
    }
    assert.equal(mock.seen.length, 0, "every one must be refused before a request is sent");
  });
});

test("arcgis race totals: an error sent as HTTP 200, a renamed layer and unreadable metadata are all said plainly", async () => {
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "dc-ocf-contributions", filters: { election_year: 2026 } });
    assert.ok(r.isError, "an error body must not be read as an empty result");
    assert.match(r.text, /could not run this connector's query \("Failed to execute query\."\).*re-verifying/);
  }, { arcgis: ({ kind, body }) => (kind === "grouped" ? { body: { error: { code: 400, message: "Failed to execute query.", details: [] } } } : { body }) });

  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "dc-ocf-contributions", filters: { election_year: 2026 } });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.registry_drift.length, 2);
    assert.match(r.json.registry_drift[0], /now reads "Somebody Else"/);
    assert.match(r.json.registry_drift[1], /now titled "Liquor Licenses".*Layer numbers can be reassigned/);
  }, { arcgis: ({ kind, body }) => (kind === "layer" ? { body: { ...body, name: "Liquor Licenses", copyrightText: "Somebody Else" } } : { body }) });

  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "dc-ocf-contributions", filters: { election_year: 2026 } });
    assert.ok(!r.isError, r.text);
    assert.match(r.json.registry_drift[0], /Could not read the layer's metadata/);
    assert.match(r.json.registry_drift[1], /Could not read when the layer was last modified/);
    assert.equal(r.json.data_updated_at, null);
  }, { arcgis: ({ kind, body }) => (kind === "grouped" ? { body } : { body: { error: { code: 500, message: "down" } } }) });
});

test("an arcgis registry entry with free text, a donor column or a loose path stops the server from starting", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "jx-"));
  const read = () => JSON.parse(fs.readFileSync(fileURLToPath(new URL("../servers/jurisdiction/sources.json", import.meta.url)), "utf8"));
  const cases = [
    [(s) => (s.filters.committee = { column: "COMMITTEENAME", type: "text" }), /arcgis sources may only take integer, enum or present filters.*committee/],
    [(s) => s.group_by.push("CONTRIBUTORNAME"), /person-level column "CONTRIBUTORNAME"/],
    [(s) => s.group_by.push("FULLADDRESS"), /person-level column "FULLADDRESS"/],
    [(s) => (s.filters.has_candidate.column = "CANDIDATENAME IS NULL OR 1=1 --"), /is not a plain table or column name/],
    [(s) => (s.service_path = "/dcgis/rest/services/../admin?x=1"), /service_path is not a plain path/],
    [(s) => (s.dataset = "34/query?where=1=1"), /an arcgis dataset is a layer number/],
    [(s) => (s.measures[0].fn = "max"), /measure "total" must be sum or count/],
    [(s) => delete s.filters.election_year, /cycle_filter_required needs cycle_filter to name one of its filters/],
    [(s) => (s.mode = "rows"), /an arcgis source must use mode grouped/],
  ];
  for (const [i, [breakIt, expected]] of cases.entries()) {
    const reg = read();
    breakIt(reg.sources.find((s) => s.id === "dc-ocf-contributions"));
    const file = path.join(dir, `sources-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(reg));
    const { messages, stderr } = await rpc("jurisdiction", [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], { env: { JX_SOURCES_FILE: file } });
    assert.equal(messages.length, 0, `case ${i}: the server must not answer with a registry it refuses`);
    assert.match(stderr, expected, `case ${i}`);
  }
});

/* -- jurisdiction on the Massachusetts OCPF Public API. The lists cannot be asked
      for one city or district, so narrowing happens on the rows that come back. -- */
const ocpfSeen = (mock) => mock.seen.filter((s) => s.path.startsWith("/reports/"));

test("locate: a Boston address offers the four Massachusetts lists, with the Census names turned into the publisher's", async () => {
  await withJx(async (call) => {
    const r = await call("jx_locate", { address: "24 Beacon St, Boston, MA 02133" });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.geography.place.name, "Boston city");
    assert.equal(r.json.geography.state_house_district.name, "14th Suffolk District");
    assert.equal(r.json.geography.state_senate_district.name, "Norfolk and Suffolk District");
    assert.deepEqual(r.json.connected_sources.map((s) => s.id), ["ma-ocpf-legislative", "ma-ocpf-mayoral", "ma-ocpf-council", "ma-ocpf-pacs"]);
    const year = String(new Date().getFullYear());
    const calls = Object.fromEntries(r.json.connected_sources.flatMap((s) => s.suggested_calls.map((c) => [c.label, c.arguments])));
    assert.deepEqual(calls["This address's state House district"], { source_id: "ma-ocpf-legislative", filters: { year, chamber: "House", office: "14th Suffolk" } }, "'District' is dropped");
    assert.deepEqual(calls["This address's state Senate district"].filters, { year, chamber: "Senate", office: "Norfolk and Suffolk" });
    assert.deepEqual(calls["Mayoral candidates in this city"].filters, { year, office: "Mayoral, Boston" }, "'Boston city' becomes 'Boston' inside the publisher's wording");
    assert.deepEqual(calls["City council candidates in this city"].filters, { year, office: "City Councilor, Boston" });
    const leg = r.json.connected_sources[0];
    assert.equal(leg.publisher, "Massachusetts Office of Campaign and Political Finance (OCPF)");
    assert.equal(leg.publisher_note, undefined);
    assert.deepEqual(leg.required_filters, ["year"]);
    assert.deepEqual(leg.filters, { year: "integer", chamber: "one of: House | Senate", office: "text, matched against the rows returned" });
  });
});

test("ocpf race totals: the year goes in the path, the office filter is never sent, and the rows are sorted and cut here", async () => {
  await withJx(async (call, mock) => {
    const r = await call("jx_race_totals", { source_id: "ma-ocpf-mayoral", filters: { year: 2025, on_ballot: "yes", office: "mayoral, boston" }, limit: 2 });
    assert.ok(!r.isError, r.text);
    const j = r.json;
    assert.equal(ocpfSeen(mock).length, 1, "one request, no metadata call");
    assert.equal(ocpfSeen(mock)[0].path, "/reports/mayoral/depository/2025");
    assert.deepEqual(ocpfSeen(mock)[0].query, { OnBallot: "true" }, "the office text stays here; only the yes/no goes to the publisher");
    const recorded = jxf("ocpf_mayoral_2025_onballot.json").filter((x) => x.officeSought === "Mayoral, Boston").map((x) => x.receiptsYtdNumeric).sort((a, b) => b - a);
    assert.equal(recorded.length, 4, "the recorded answer has four Boston filers, so the cut to two is tested");
    assert.deepEqual(j.rows.map((x) => x.receiptsYtdNumeric), recorded.slice(0, 2), "biggest first, although the publisher sends them unsorted");
    assert.equal(j.returned, 2);
    assert.equal(j.may_be_more, true);
    assert.equal(j.filers_in_answer, 68);
    assert.deepEqual(Object.keys(j.rows[0]), ["filerName", "officeSought", "partyAffiliation", "receiptsYtdNumeric", "expendituresYtdNumeric", "currentCashOnHandNumeric", "bankReportEndDate"]);
    assert.match(j.rows[0].bankReportEndDate, /^2025-\d\d-\d\d$/, "M/D/YYYY text is turned round");
    assert.equal(j.newest_report_date, "2025-12-31", "as text, 9/30/2025 would sort after 12/31/2025");
    assert.equal(j.data_updated_at, null);
    assert.equal(j.registry_drift, undefined);
    assert.match(j.notes.join(" "), /does not say when the list was last refreshed. The newest reporting period in it ends 2025-12-31/);
    assert.match(j.notes.join(" "), /sends no credit with the data.*was not re-checked on this call/);
    assert.match(j.notes.join(" "), /Data published by Massachusetts Office of Campaign and Political Finance \(OCPF\)\./);
  });
});

test("ocpf race totals: Census spellings match the publisher's, and a miss lists what the publisher does call things", async () => {
  await withJx(async (call, mock) => {
    const senate = await call("jx_race_totals", { source_id: "ma-ocpf-legislative", filters: { year: 2026, chamber: "senate", office: "Norfolk and Suffolk District" } });
    assert.ok(!senate.isError, senate.text);
    assert.deepEqual(ocpfSeen(mock)[0].query, { DisplayGroup: "Senate" }, "the registry's spelling of the chamber is sent");
    assert.equal(senate.json.returned, 2);
    assert.ok(senate.json.rows.every((x) => x.officeSought === "Norfolk & Suffolk"), "'and' matches '&' and 'District' is ignored");

    const miss = await call("jx_race_totals", { source_id: "ma-ocpf-council", filters: { year: 2025, office: "City Councilor, Springfeld" } });
    assert.ok(!miss.isError, miss.text);
    assert.equal(miss.json.returned, 0);
    assert.match(miss.json.notes[0], /Nothing in this answer has office "City Councilor, Springfeld"/, "the miss is the first thing read");
    assert.ok(miss.json.office_values_in_this_answer.length > 0);
    assert.ok(miss.json.office_values_in_this_answer.every((v) => /^City Councilor, /.test(v)), "office names only");

    const pacs = await call("jx_race_totals", { source_id: "ma-ocpf-pacs", filters: { year: 2026 }, limit: 3 });
    assert.equal(pacs.json.returned, 3);
    assert.ok(pacs.json.rows[0].receiptsYtdNumeric >= pacs.json.rows[2].receiptsYtdNumeric);
  });
});

test("ocpf race totals: the year is required, and filters the registry does not list are refused before any request", async () => {
  await withJx(async (call, mock) => {
    const missing = await call("jx_race_totals", { source_id: "ma-ocpf-mayoral", filters: { office: "Mayoral, Boston" } });
    assert.ok(missing.isError);
    assert.match(missing.text, /needs a "year" filter\. The publisher keeps these lists one year at a time\./);
    const bad = [
      { year: "2025/../../search/items" },
      { year: "2025?Name=Smith" },
      { year: 2025, Name: "Smith" },
      { year: 2025, DistrictCodeSought: "35" },
      { year: 2025, on_ballot: "true&Name=Smith" },
      { year: 2025, chamber: "Senate" },
      { year: 2025, office: "Mayoral, Boston\nX-Injected: 1" },
      { year: 2025, office: "<script>" },
    ];
    for (const filters of bad) {
      const r = await call("jx_race_totals", { source_id: "ma-ocpf-mayoral", filters });
      assert.ok(r.isError, `accepted ${JSON.stringify(filters)}`);
    }
    assert.ok((await call("jx_race_totals", { source_id: "ma-ocpf-legislative", filters: { year: 2026, chamber: "Other" } })).isError, "a chamber the registry does not list");
    assert.equal(mock.seen.length, 0, "every one must be refused before a request is sent");
  });
});

test("ocpf race totals: an empty list, a dropped field and a changed shape are all said plainly", async () => {
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "ma-ocpf-mayoral", filters: { year: 1999 } });
    assert.ok(!r.isError, "an empty list is an answer, not a failure");
    assert.equal(r.json.returned, 0);
    assert.match(r.json.notes[0], /sent an empty list for 1999.*not proof that nobody filed/);
    assert.equal(r.json.newest_report_date, null);
  });
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "ma-ocpf-mayoral", filters: { year: 2025 } });
    assert.ok(r.isError);
    assert.match(r.text, /no longer sends receiptsYtdNumeric.*re-verifying/);
  }, { ocpf: ({ body }) => ({ body: body.map(({ receiptsYtdNumeric, ...rest }) => rest) }) });
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "ma-ocpf-council", filters: { year: 2025 } });
    assert.ok(r.isError);
    assert.match(r.text, /answered without a list of filers/);
  }, { ocpf: () => ({ body: { message: "moved" } }) });
  await withJx(async (call) => {
    const r = await call("jx_race_totals", { source_id: "ma-ocpf-mayoral", filters: { year: 2025 } });
    assert.ok(!r.isError, r.text);
    assert.match(r.json.registry_drift[0], /no longer sends these as numbers: receiptsYtdNumeric/);
  }, { ocpf: ({ body }) => ({ body: body.map((x) => ({ ...x, receiptsYtdNumeric: String(x.receiptsYtdNumeric) })) }) });
});

test("an ocpf registry entry with a free-text parameter, a loose path or a local filter on an unlisted column stops the server from starting", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "jx-"));
  const read = () => JSON.parse(fs.readFileSync(fileURLToPath(new URL("../servers/jurisdiction/sources.json", import.meta.url)), "utf8"));
  const cases = [
    [(s) => (s.filters.name = { in: "query", param: "Name", type: "text" }), /filter "name" is not one an ocpf source can take/],
    [(s) => (s.filters.office.column = "cpfId"), /local filter "office" must name a column in select/],
    [(s) => (s.dataset = "/search/items?searchType=A&year={year}"), /an ocpf dataset is a plain path ending in \{year\}/],
    [(s) => (s.dataset = "/reports/mayoral/depository"), /an ocpf dataset is a plain path ending in \{year\}/],
    [(s) => (s.filters.on_ballot.param = "OnBallot&Name"), /filter "on_ballot" is not one an ocpf source can take/],
    [(s) => (s.cycle_filter_required = false), /an ocpf source must require its year/],
    [(s) => s.select.push("contributorName"), /person-level column "contributorName"/],
    [(s) => (s.order_by = "cpfId DESC"), /order_by must be one selected column/],
  ];
  for (const [i, [breakIt, expected]] of cases.entries()) {
    const reg = read();
    breakIt(reg.sources.find((s) => s.id === "ma-ocpf-mayoral"));
    const file = path.join(dir, `sources-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(reg));
    const { messages, stderr } = await rpc("jurisdiction", [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], { env: { JX_SOURCES_FILE: file } });
    assert.equal(messages.length, 0, `case ${i}: the server must not answer with a registry it refuses`);
    assert.match(stderr, expected, `case ${i}`);
  }
});

/* -- publisher terms: what each publisher's own pages say about using the data
      travels with every result, and a condition is quoted, never interpreted. -- */

test("every source carries its publisher's terms, and a condition is quoted word for word in results", async () => {
  await withJx(async (call) => {
    const all = await call("jx_sources", {});
    assert.ok(!all.isError, all.text);
    for (const s of all.json.connected_sources) {
      assert.match(s.publisher_terms.read_on, /^\d{4}-\d{2}-\d{2}$/, `${s.id}: terms carry the date they were read`);
      assert.match(s.publisher_terms.source, /^https:\/\//, `${s.id}: terms name where they were read`);
      assert.ok(s.publisher_terms.summary.length > 40, `${s.id}: terms carry a summary`);
      assert.ok(s.publisher_terms.condition === null || s.publisher_terms.condition.length > 40, `${s.id}: a condition is the publisher's words or null`);
    }
    const withCondition = all.json.connected_sources.filter((s) => s.publisher_terms.condition).map((s) => s.id).sort();
    assert.deepEqual(withCondition, ["hi-csc-contributions", "phl-campfin-summary", "wa-pdc-summary"], "three publishers attach a condition; the rest were read and found open");

    const wa = await call("jx_race_totals", { source_id: "wa-pdc-summary", filters: { election_year: 2026 } });
    assert.ok(!wa.isError, wa.text);
    const cond = wa.json.notes.find((n) => /attaches a condition/.test(n));
    assert.ok(cond, "a condition is in the notes");
    assert.match(cond, /may not be used for commercial purposes/, "the publisher's own words");
    assert.match(cond, /Repeat it to the user; do not interpret whether their use is allowed/);
    assert.ok(wa.json.notes.indexOf(cond) < wa.json.notes.findIndex((n) => /Filter values must match/.test(n)), "the condition comes before the source's own notes");

    const hi = await call("jx_race_totals", { source_id: "hi-csc-contributions", filters: { county: "Honolulu" } });
    assert.match(hi.json.notes.find((n) => /attaches a condition/.test(n)), /The data made available here was modified for use from its original source, which is opendata\.hawaii\.gov/, "Hawaii's required disclaimer travels with the data");

    const nyc = await call("jx_race_totals", { source_id: "nyc-cfb-analysis" });
    assert.ok(!nyc.json.notes.some((n) => /attaches a condition/.test(n)), "an open publisher gets no condition");
    assert.match(nyc.json.notes.find((n) => /terms were read on/.test(n)), /There are no restrictions on the use of Open Data/);
  });
});

test("a registry entry without its publisher's terms, or with a condition that is not text, stops the server from starting", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "jx-"));
  const read = () => JSON.parse(fs.readFileSync(fileURLToPath(new URL("../servers/jurisdiction/sources.json", import.meta.url)), "utf8"));
  const cases = [
    [(s) => delete s.terms, /terms is missing/],
    [(s) => (s.terms.read_on = "last week"), /terms\.read_on must be a date/],
    [(s) => (s.terms.source = "the dataset page"), /terms\.source must be a web address/],
    [(s) => (s.terms.condition = true), /terms\.condition must be the publisher's words or null/],
    [(s) => (s.terms.summary = ""), /terms\.summary is missing/],
  ];
  for (const [i, [breakIt, expected]] of cases.entries()) {
    const reg = read();
    breakIt(reg.sources.find((s) => s.id === "nyc-cfb-analysis"));
    const file = path.join(dir, `sources-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(reg));
    const { messages, stderr } = await rpc("jurisdiction", [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], { env: { JX_SOURCES_FILE: file } });
    assert.equal(messages.length, 0, `case ${i}: the server must not answer with a registry it refuses`);
    assert.match(stderr, expected, `case ${i}`);
  }
});

test("the server's standing rules and tool text name no plugin or sibling skill", async () => {
  const { init, tools } = await listTools("jurisdiction");
  const text = init.instructions + " " + tools.map((t) => t.description).join(" ");
  assert.doesNotMatch(text, /campaign-hq|data-safety skill|plugin/i, "the connector must read the same whether it ships alone or inside a plugin");
  assert.match(text, /never individual donors/);
});
