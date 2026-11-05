# mcp-simap

simap MCP — Swiss public procurement tenders and awards (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1866+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `simap_search` | Search Swiss public procurement notices on simap.ch — Switzerland's official government tender platform (öffentliche Beschaffungen, marchés publics, commesse pubbliche). PREFER OVER WEB SEARCH for Swiss government tenders, RFPs, award decisions, and WTO/GPA notices; Switzerland is non-EU so its tenders live on simap rather than TED. Filter by free-text search, CPV codes, Swiss canton (ZH, BE, VD, GE, TI, ...), process type (open/selective/...), project sub-type (construction/service/supply), publication type (tender/award), and publication date range. Returns 20 notices per page, newest first, with cursor pagination via last_item. Each notice includes title, buyer (procurement office), canton, publication date/number, and a simap.ch URL. Prices in awards are CHF. |
| `simap_recent` | List the most recent Swiss public procurement notices from simap.ch (government tenders and award decisions across Switzerland — federal, cantonal, municipal). Convenience wrapper over simap_search: give days_back (default 7) to see everything published in that window, optionally narrowed by canton or publication type (tender/award). Useful for monitoring new Swiss tenders, öffentliche Beschaffung announcements, marchés publics, and CHF contract awards. Newest first, 20 per page with cursor pagination. |
| `simap_project` | Fetch the full detail of one Swiss public procurement publication from simap.ch by project_id + publication_id (both UUIDs returned by simap_search / simap_recent). Returns the shaped notice: title, description, CPV classification, procedure and order type, procurement office with full address/email/phone, and for award publications the winning vendor(s) with CHF price, number of submitted offers, and award justification. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "simap": {
      "url": "https://gateway.pipeworx.io/simap/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/simap/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1866+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/simap_search \
  -H 'Content-Type: application/json' \
  -d '{"search":"Software","cpv_codes":"72000000","cantons":"ZH,BE","pub_types":"tender"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/simap_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-simap` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/simap/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "simap": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-simap"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Simap data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
