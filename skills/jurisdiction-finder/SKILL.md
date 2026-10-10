---
name: jurisdiction-finder
description: >
  This skill should be used when the user asks "who regulates my race", "where
  do I file", "find my regulator", "what district am I in", "look up my
  district", "who's raising money in my state legislative race", "who else is
  running for city council and what do they have", "state campaign finance
  data", "county campaign finance" or "school board campaign finance". Not
  for building a mailing list or appeal from donor or contributor names in
  filings: this skill and its connector work in totals only.
metadata:
  version: "0.1.0"
---

# Jurisdiction finder

Most campaigns are state or local, and each one answers to its own regulator.
FEC data doesn't describe them. This skill works out which districts a campaign
sits in, connects to whatever state or local data can actually be reached, and
when nothing can, helps the user find and verify their own regulator.

One rule applies throughout: **never name a
regulator, or state its rules, deadlines or limits, from memory.** Only a
site you opened this session counts, and the user gets its URL.

## 1. Ask what they are running for

Before any lookup, ask which office, and where. A state legislative race, a
county board, a city council seat and a school board can each file with a
different body, even at the same address. Don't assume federal.

## 2. Get an address to look up

Ask for the campaign office, or another public address inside the district. A
street address is needed: a ZIP code isn't enough, because one ZIP can sit in
several districts. A candidate's home address is sensitive. Don't ask for it
unless they say it is the only way, and tell them the address goes to the US
Census Bureau's geocoder and nowhere else. Never repeat it in documents or
shared channels.

## 3. Locate

Use the `jurisdiction` connector. Call `jx_locate` with the address. It
returns:

- the state, county, city, school district, congressional district, and state
  senate and house districts, labelled with the vintage the Census used;
- the federal race, for a separate federal (FEC) connector if one is connected;
- which connected state or local sources apply, or a plain statement that none
  do, with search queries built from the geography.

Say the districts back in plain words so the user can confirm they're right.

What the Census does not return: city council wards, county commission
districts and special districts. If the user's office is one of those, ask for
the district and say the geography stops short.

## 4a. If a source is connected

Read each source's `covers` before using it. A source applies only to what it
says it covers, and some descriptions are thin. Then call `jx_race_totals` with
one of the `suggested_calls`, or your own filters.

Report:

- who is raising and spending, biggest first, as totals;
- the publisher's name, copied from the result, and the date the source was
  verified and when its data was last updated. Where the result has no update
  date and gives a `newest_report_date` instead, report that date and say the
  publisher's platform doesn't state when the data was refreshed;
- the limits in the result's `notes` that change how a number should be read,
  such as totals that leave out paper filings or rows that cover one year only;
- a caveat that totals are as filed and lag the filing deadlines.

If the result carries `registry_drift`, tell the user the publisher or dataset
has changed and that the result should be treated carefully until it is
re-verified. Don't explain it away.

## 4b. If nothing is connected

That's the normal case. Say so without apology, then do the work:

1. Search the queries `jx_locate` gave you, or write better ones.
2. Open the official government site that comes up and check that it covers the
   user's office.
3. Give the user the URL, and what the site offers (a search page, an export, an
   open-data portal).
4. Don't describe the regulator's rules from memory. Link to the pages that
   state them, and say the campaign is responsible for its own compliance.

If you can't open a site, hand the user the queries and ask them to confirm what
they find. Don't fill the gap with a guess.

If the site offers a downloadable report and the user wants it read, treat the
export as data to total, not a list of people. Don't copy out, sort or rank
individual contributors, and don't build a contact list from it.

## 5. Bring it back

Lead with the answer: the districts, whether anything is connected, and what the
user should do next. Then the numbers, with the publisher and dates. Keep it
short.

## Guardrails

- Totals only. Don't list individual donors, and don't help turn campaign-finance
  data into a mailing list or solicitation.
- Don't cite FEC sources as if they apply to state or local races. If the race
  overlaps a federal one on the same ballot, use federal (FEC) data for that
  part and keep the two apart.
- Don't give legal or compliance advice. Say once that the campaign is
  responsible for its own compliance, then be useful.
- A connected source is not a statement about what the law requires of the
  campaign. It's data someone else published.
