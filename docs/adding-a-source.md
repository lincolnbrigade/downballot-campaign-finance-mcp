# Adding a source

A source is one entry in `servers/jurisdiction/sources.json`. It describes one fixed query against one public dataset. Adding one usually needs no change to the server code, unless the dataset sits on a platform the server does not know yet.

## Is it a good candidate?

A source belongs here when all four of these are true.

A government body publishes the dataset or is credited for it, and you can read that credit on the dataset's own record.

It needs no key, no account and no form. Do not sign up for anything, submit a form or work around a bot check to reach data.

Totals can be had without fetching people. Either the publisher offers a summary table, or its server can do the adding for you. If the only way to a total is to page through contributor rows, the source does not belong here.

You have read what the publisher says about using the data. Add what you found to the README's terms table.

## The steps

1. Read the dataset's own metadata and find the record that names the publisher and the title. Copy both word for word into `publisher` and `dataset_name`. Do not write an agency name from memory.
2. Decide whether the credit is an agency. If the record credits a city, a state or an open-data portal, set `"publisher_is_agency": false`. Results then say so.
3. Write `covers` and `covers_basis`. Say what the dataset covers in the publisher's words, and say where that statement comes from. If the publisher's description is thin, say it is thin.
4. Write one fixed query. Choose the columns to return, and leave out every column that describes a contributor, an employer, a street address, a phone number or an email address. The server refuses to start if one is listed.
5. List the filters a caller may set, and keep the list short. The rules for each platform are below.
6. Name the cycle filter. `cycle_filter` is the filter that pins a year or election period. If an unfiltered answer would be wrong or cut off, set `"cycle_filter_required": true` and give a one-sentence `cycle_filter_reason`.
7. Write `notes`. These are the limits a reader needs in order to read a number correctly: what a row is, what is left out, and what the publisher does not define. Quote the publisher's documentation where you can, and say when you are describing something you observed.
8. Record a fixture. Save one real answer under `tests/fixtures/jurisdiction/`, made with the exact query the entry builds. Keep it small, and check it for email addresses, phone numbers and contributor fields.
9. Add tests. Cover at least the request the server sends, the shape of the rows that come back, the refusal of unlisted filters before any request goes out, and what happens when the publisher changes a column or fails.
10. Run the checks.

    ```bash
    npm test
    npm run verify
    ```

11. Update the README. Add the source to the sources table, and add its publisher to the terms table.
12. Change `verified_on` only after the verify script passes for every source.

## Filter rules by platform

| Platform | Filter types allowed | Why |
|---|---|---|
| `socrata` (the default) | `integer`, `text`, `enum` | Values travel as separate URL parameters, so text cannot become part of a query. |
| `carto` | `integer`, `enum`, `present` | The request is a SQL statement. Only digits, the registry's own list values and a yes/no may shape it. |
| `arcgis` | `integer`, `enum`, `present` | The `where` clause is SQL text. `present` is a yes/no that asks whether a column is filled in. |
| `ocpf` | the year `in: "path"`, `boolean` or `enum` `in: "query"`, and `local` | The server compares a `local` filter against the rows that came back and does not send it. |

An `enum` filter lists its allowed `values` in the registry. The server matches the caller's text against that list without regard to case and sends the registry's spelling.

`require_in` (Carto and ArcGIS) is a fixed condition that every query carries. Use it to leave out kinds of row, such as filers who are private individuals.

## What the server refuses at start-up

- A column name matching contributor, donor, employer, occupation, address, phone, email, street, zip or treasurer, anywhere in the entry.
- A free-text filter on a platform that takes SQL text.
- A table, column or list value that is not plain. Quotes, spaces in a column name and semicolons all count.
- A `local` filter naming a column that is not in `select`.
- An unknown platform, or a required cycle filter that is not one of the entry's filters.

A refused registry stops the server. This is deliberate. If an entry cannot pass these checks, change the entry.

## Adding a platform

If the dataset sits on a platform the server does not know, add an entry to the `PLATFORMS` map in `servers/jurisdiction/index.js` with two functions.

`prepare(source, filters, limit)` validates the filters and builds the request without sending anything. It must throw on a bad filter, so that a bad request never reaches the publisher.

`run(source, request)` sends the request and returns the rows, anything it could re-check about the publisher, and how fresh the data is.

Write down what you observed about the platform in the comment at the top of that file, with the date. Add a branch for it in `tests/verify-jurisdiction-sources.mjs`.

## Things that have gone wrong before

Two of the platforms here ignore paging or sorting parameters. Check by asking for three rows and counting what comes back.

One platform reports a failed query as HTTP 200 with an error body. Another answers a path that does not exist with an empty list.

Dates sometimes arrive as text. Compared as text, `9/30/2025` sorts after `12/31/2025`.

A descending sort can put rows with no amount at the top.

A site's public pages may not mention an API that exists and is documented elsewhere. One "no API found" in this project's early research was wrong for that reason.
