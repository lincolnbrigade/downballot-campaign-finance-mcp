# downballot-campaign-finance-mcp

A read-only MCP server for down-ballot races in the United States: state legislature, county, city and school board. It's kind of limited because not a lot of down-ballot jurisdictions have easily accessible campaign finance data. Hopefully that continues to improve over time.

The MCP server lets you give an AI assistant a street address and returns the state, county, city, school district, congressional district and both state legislative districts, using the US Census Bureau's public geocoder.

It also holds a small registry of state and local campaign-finance datasets which are checked against the live publisher. Where a source covers the address, the server returns totals for candidates and committees. If it doesn't it says so and helps the AI assistant find the regulator on its official site.

This MCP doesn't need any API keys and has no dependencies. The whole server is one Node.js file and one JSON registry.

This is *not* legal or compliance advice. A campaign is responsible for its own compliance.

## What it will not do

It doesn't return individual donors. Results hold totals and the names of candidates and committees, and there is no way to ask for contributor names, employers or addresses. The section on [how "totals only" is enforced](#how-totals-only-is-enforced) explains why.

It doesn't name a regulator from memory. Every regulator's name is copied word for word from the dataset's own record. Most states are not connected and for those the server returns search wording and tells the assistant to open the official Secretary of State (or similar) site.

It has no data on filing rules, deadlines or contribution limits, so it will not state them (no compliance advice!).

It doesn't cover federal races. Federal data lives at the FEC, and several open-source FEC servers already exist. `jx_locate` does name the federal race for an address so another tool can pick it up, and it mentions three tool names (`fec_race_money` and two others) that belong to a separate FEC connector, not to this one.

## Connected sources

The registry holds ten sources. All ten were last checked against their live publishers on 2026-10-05.

| Place | What you get | Credit on the data | Platform |
|---|---|---|---|
| Washington State | One summary row per campaign or committee per election year, with office and jurisdiction | Public Disclosure Commission | Socrata |
| Hawaii | Contributions to state and county candidates, totalled per candidate per election period | State of Hawaii; Campaign Spending Commission | Socrata |
| New York City | Financial analysis, one row per candidate per election cycle | Campaign Finance Board (CFB) | Socrata |
| Austin, TX | Contributions totalled per recipient | City of Austin, Texas - data.austintexas.gov (a portal credit; the record's ownership field names the Austin City Clerk's Office) | Socrata |
| Philadelphia, PA | Each filer's yearly totals: contributions, spending, cash and debts | City of Philadelphia (a city credit, not an agency) | Carto |
| District of Columbia | Contributions totalled per committee per election year | Office of Campaign Finance | ArcGIS |
| Massachusetts | Legislative candidates, year to date | Massachusetts Office of Campaign and Political Finance (OCPF) | OCPF Public API |
| Massachusetts | Mayoral candidates, year to date | same | OCPF Public API |
| Massachusetts | City council candidates, year to date | same | OCPF Public API |
| Massachusetts | Political action committees, year to date | same | OCPF Public API |

Each source describes what it covers in its `covers` field and gives the basis for that description. Some publishers' descriptions are thin. Where that is so, the registry says it is thin and leaves the gap unfilled.

Everywhere else is not connected. For most addresses that is the expected answer, and the server reports it as an answer.

## Quick start

### In the Claude desktop app, with no terminal

Download the `.mcpb` file from the [latest release](https://github.com/lincolnbrigade/downballot-campaign-finance-mcp/releases/latest), open it, and click Install. The app runs the server with its own copy of Node, so you do not need Node installed. Then ask, in a new chat, "check the jurisdiction connection".

### In any other MCP client

You need Node.js 18 or later. There is nothing to install beyond cloning the repository.

```bash
git clone https://github.com/lincolnbrigade/downballot-campaign-finance-mcp.git
```

Then add the server to your client. For clients that use an `mcpServers` block:

```json
{
  "mcpServers": {
    "jurisdiction": {
      "command": "node",
      "args": ["/absolute/path/to/downballot-campaign-finance-mcp/servers/jurisdiction/index.js"]
    }
  }
}
```

Restart the client and ask it to "check the jurisdiction connection". It should call `jx_status` and report ten connected sources.

## Tools

| Tool | What it does |
|---|---|
| `jx_status` | Reports what is connected and when it was last verified. It makes no network call. |
| `jx_locate` | Turns a street address into districts, says which connected sources apply, and suggests calls for them. It refuses a ZIP code on its own, because one ZIP can sit in several districts. |
| `jx_sources` | Lists the connected sources, either all of them or those for one state. |
| `jx_race_totals` | Returns totals from one source, biggest first. You can set only the filters that source allows. |

## Reading a result

Every result from `jx_race_totals` names the publisher as the dataset's own record credits it, and gives the date the source was last verified.

It also says how fresh the data is. Where the publisher gives a last-updated date, the result carries that date. Where the publisher gives none, the result carries the newest report or record date found in the data, with a note explaining the substitution.

If the publisher's name, the dataset's title or a column type has changed since the source was verified, the result includes `registry_drift`. Treat the numbers with care until the source is re-verified.

The `notes` field lists the limits that change how a number should be read. Philadelphia's totals leave out money reported only on paper filings, for example, and each Massachusetts list covers one calendar year.

Each source also carries `publisher_terms`: what the publisher's own pages say about using the data, read at the source on a known date. Where a publisher attaches a condition, every result quotes it in the publisher's words and leaves the reading of it to you.

Totals are as filed with the publisher. Nobody has audited them, and they lag the filing deadlines.

## Privacy

The street address you give `jx_locate` goes to the US Census Bureau's geocoder. The server does not store it or repeat it back. A candidate's home address is sensitive, so use a campaign office or another public address when you can.

## How "totals only" is enforced

Callers never write queries. Each registry entry is one fixed query, and a caller can set only the filters that entry lists.

How a filter travels depends on the platform. Socrata sources send filter values as separate URL parameters, so a value cannot become part of the query. Carto and ArcGIS sources take SQL text, so they accept three kinds of filter: a whole number, a pick from a list held in the registry, or a yes/no. Text typed by a caller cannot reach the SQL. Massachusetts cannot be asked for one city or district, so the server narrows the rows after they arrive. It compares the caller's text against those rows and does not send it to the publisher.

At start-up the server refuses a registry that selects a donor, employer or address column, or that gives a SQL-text source a free-text filter. A bad registry stops the server.

## Checking the sources

Open-data portals rename and retire datasets without notice.

```bash
npm run verify
```

This checks every source against its live publisher. It confirms that the dataset still exists, that the publisher credit and title are unchanged, that every column the server uses is still there with the right type, and that one real query answers. It prints column names and counts and leaves row contents out. It needs no key.

A scheduled workflow runs the check monthly and opens an issue when it fails.

## Publisher terms

The server stores nothing. It passes totals through when asked. A publisher's terms still apply to whoever uses the data, so each publisher's pages were read at the source on 2026-10-05. This section records what those pages say. It is not legal advice.

| Publisher | What its own pages say | Where |
|---|---|---|
| Washington Public Disclosure Commission | The dataset carries a condition of release: it is a list of individuals and "may not be used for commercial purposes", and people who receive it agree to that limit. It cites RCW 42.56.070, which bars agencies from providing lists of individuals for commercial purposes. The record's licence field says Public Domain. | Dataset description on data.wa.gov; RCW 42.56.070(8) |
| Hawaii Campaign Spending Commission | Licence field: Public Domain. The state's open-data terms require anyone who uses a dataset in an application to show a set disclaimer (below). | Dataset record; opendata.hawaii.gov terms of use |
| New York City Campaign Finance Board | "There are no restrictions on the use of Open Data." The dataset record has no licence field. | NYC Open Data FAQ |
| City of Austin | Data is "offered free and without restriction" and is in the public domain unless a dataset says otherwise. The city asks for credit to both the City of Austin and the department. This dataset's record names the Austin City Clerk's Office. | Open Data Terms of Use; dataset record |
| City of Philadelphia | The city "reserves all rights in the database and any data contained therein", gives the data "as is", and makes the user responsible for its use. Its general website terms prohibit commercial use and republication without written permission. Whether those website terms reach the open data is not stated. | metadata.phila.gov terms of use; phila.gov terms of use |
| District of Columbia Office of Campaign Finance | The dataset's catalogue entry is licensed Creative Commons Attribution 4.0. The District's data policy says open data has no restrictions on commercial or non-commercial use and asks for attribution. | Open Data DC item and Data Policy |
| Massachusetts OCPF | No restriction on readers found in the state campaign finance law as the agency publishes it, its data pages, its API description or its data dictionary. | api.ocpf.us; ocpf.us |

Hawaii's required disclaimer, which applies when Hawaii data is shown in an application:

> The data made available here was modified for use from its original source, which is opendata.hawaii.gov The State of Hawaii does not vouch for the quality and timeliness of the data presented herein, any analysis of the data presented herein, nor any content, viewpoints, products, or services presented herein.

Three things were not read: Washington Attorney General Opinion 1975 No. 15, which the Washington dataset cites; New York City's Open Data Law, whose host blocks automated reading; and the Massachusetts regulations.

## Adding a source

[docs/adding-a-source.md](docs/adding-a-source.md) has the full steps. The outline: read the dataset's own metadata, copy the publisher fields word for word, write one fixed query with allow-listed filters, record a fixture, add a test, and pass the verify script.

## The optional skill

[skills/jurisdiction-finder/SKILL.md](skills/jurisdiction-finder/SKILL.md) is a written guide for an AI assistant. It tells the assistant to ask which office the campaign is running for, look up the address, use a connected source if one applies, and otherwise find the regulator on its official site. Tools that support skill folders can load it. The server works without it.

## Tests

```bash
npm test
```

The tests replace every publisher with a local stand-in that serves responses recorded from the real one, so they need no network. They cover the fixed queries, the guards, the refusal of a bad registry, and what happens when a publisher changes or fails.

The fixtures under `tests/fixtures/jurisdiction/` are small slices of public records. They contain the names of candidates and committees as filed and no contributor information. The geocoder fixtures are public buildings.

## Layout

```
servers/jurisdiction/index.js       the server (one file, no dependencies)
servers/jurisdiction/sources.json   the registry of sources
skills/jurisdiction-finder/         the optional skill
tests/                              tests, fixtures and the live verify script
docs/adding-a-source.md             how to add a source
manifest.json, scripts/build-mcpb.mjs  the one-click bundle for the Claude desktop app
```

## Licence

MIT. See [LICENSE](LICENSE).

The licence covers this code. The data belongs to its publishers and is subject to their terms.
