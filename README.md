# opencode-quota

Quota tracking for OpenCode V2. Adds a `/quota` command that reports the quota
remaining on every connected account, for both **Antigravity** and **OpenAI
(Codex / ChatGPT plan)**.

This is a standalone plugin. It holds no credentials of its own — it asks the
plugins and integrations that already have them.

```
/quota
```

```
Antigravity
work@example.com
  Claude: 43%, resets in 2h
  Gemini Pro: 88%
  Gemini CLI · gemini-3-pro-preview: 80%

OpenAI (Codex)
me@example.com (pro)
  Primary window: 73%, 5h window
  Weekly window: 96%, 7d window
  GPT-5.3-Codex-Spark: 100%
```

## Install

Add the package to `plugins` in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-antigravity-auth", "opencode-quota"]
}
```

Then run `/connect` to connect at least one account, and `/reload` (or restart
OpenCode) to pick up the new plugin.

## Where the numbers come from

The two providers work very differently, and that shapes what you can expect.

### Antigravity — delegated to the Antigravity plugin

`opencode-quota` does not talk to Google. The
[`opencode-antigravity-auth`](https://github.com/oberdfr/opencode-antigravity-auth)
plugin owns the Antigravity credentials, so it exposes a read-only
`antigravity.quota` RPC and this plugin calls it. That RPC is a passthrough to
the quota engine that plugin already has: it performs no quota logic of its own
and never writes account state.

Reporting per-group Antigravity quota (Claude, Gemini Pro, Gemini Flash) and the
separate Gemini CLI quota buckets therefore costs no extra API calls beyond the
ones the Antigravity plugin already makes.

Install that plugin too, or `/quota` will note that it is not answering.

### OpenAI (Codex) — polled directly

Codex quota is read from the WHAM usage endpoint with the ChatGPT OAuth
credential OpenCode stores for the `openai` integration:

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access token>
ChatGPT-Account-ID: <account id>
```

This is the same endpoint the official Codex client polls. Two caveats worth
knowing:

- **It is an undocumented internal endpoint.** The payload has changed shape
  between releases, so the parser accepts every shape observed so far: the current
  `rate_limit.primary_window` / `secondary_window` with `used_percent`, and the
  older `five_hour` / `weekly` with `percent_left`. A future change may need the
  parser updated.
- **It needs a ChatGPT OAuth account, not an OpenAI API key.** An API-key
  connection reports a note instead of quota.

If a request fails, `/quota` says so rather than failing the whole report.

## Options

Pass options with the object form in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-quota",
      "options": {
        "observeCodexHeaders": false
      }
    }
  ]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `observeCodexHeaders` | `false` | Fallback only. Reads Codex quota from `x-codex-*` response headers instead of polling. **Leave this off unless polling is blocked for you**: registering an `http.response` hook keeps the provider on HTTP transport, which forfeits the WebSocket context reuse that OpenAI Responses sessions otherwise get. With it off, no HTTP hook is registered and WebSocket stays available. |

## Design

One package, two entrypoints, both loaded automatically:

| File | Role |
| --- | --- |
| `src/index.ts` | Server plugin. Resolves credentials, queries both providers, exposes the report over RPC. |
| `src/tui.tsx` | Terminal plugin. Registers `/quota` and renders the report in a dialog. |
| `src/rpc.ts` | The shared report contract and the response validator both halves use. |

The command lives in the terminal half on purpose. A server-side command would
have to be implemented as a prompt, which would spend a model turn to print a
table. Keeping the two halves split also means the report is computed where the
credentials already are, and only the rendered text crosses to the terminal.

`/quota` is available in the terminal interface. `opencode run` has no slash
command palette, so it is not available there.

## Credits

Quota semantics were modelled on
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), which tracks Codex
quota the same two ways: the WHAM usage endpoint and `x-codex-*` response
headers.

## Disclaimer

Reads quota from Google and OpenAI endpoints that are not documented as public
APIs. It reports what those endpoints return and nothing more.
