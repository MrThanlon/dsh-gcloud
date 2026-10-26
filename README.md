# dsh-google-cloud-llm

[简体中文](README.zh.md) | [English](README.md)

Use Gemini models in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through the **Gemini Enterprise Agent Platform (Vertex AI)**. The plugin registers the `google-cloud` route and adds it to the Models page provider list; that **Google Cloud** row under **Settings → Models** is the only place to configure it (project ID, location, base URL, proxy, API key, fallback model catalog). The plugin adds no settings page of its own.

## Features

**Chat and streaming**

- Native `streamGenerateContent` (SSE) streaming, turned into Harness `text-delta` / `reasoning-delta` chunks token by token.
- Native function calling: `functionCall` / `functionResponse` in both directions. The native parts Gemini returns — including every `thoughtSignature` — are stored in `replayState` and echoed back verbatim on the next turn, so multi-turn tool loops are not rejected with a 400. The replay envelope carries the model id, so history from another model or provider is never reused by mistake.
- Thinking summaries: `off` / `low` / `medium` / `high`. Gemini 2.5 takes a `thinkingBudget` (low 1024 / medium 8192 / high 24576, 32768 for Pro; Pro cannot disable thinking, so `off` sends `-1` for a dynamic budget); Gemini 3 and later take a `thinkingLevel`, where `off` maps to `MINIMAL` on 3.0 / 3.1 / 3.5 / 3.6 Flash and Flash-Lite and to `LOW` elsewhere. `off` is the lowest level and returns no thought text.
- Usage reporting: input, output and thinking tokens, plus cache-hit tokens.
- Stream idle timeout: with no new event for 300 seconds by default the call fails with `TIMEOUT` (tunable via `streamIdleTimeoutMs`); an upstream cancellation aborts the connection immediately and ends with `ABORTED`.

**Input**

- Image input: an `type: 'image'` block is projected into Gemini `inlineData`. Attachments are resolved through five fallbacks — `attachments.readImageRequest` (downscaled to 2048×2048, 4 MB cap) → `attachments.readImage` → `attachments.imageHostPath` → the reference's own `path` / `readonlyPath` → DSH content-addressed storage (`$DSH_HOME/attachments/v1/objects/…` or `~/.dsh/attachments/v1/objects/…`). Only when all of them miss does the part degrade to the `[image attachment omitted by this route]` placeholder.
- File attachments still travel as `[file <name>]` placeholder text.

**Request shaping** (every rule here was taught by a Vertex 400)

- Plain-text parts inside a user turn always go before the `functionResponse` parts: Vertex misreads a user turn whose `functionResponse` is followed by text as ending with a model turn and refuses the whole request (`Requests ending with a model turn are not supported`).
- A trailing model turn with no tool results is dropped: an interrupted session leaves behind "the model called a tool, the result never arrived", and keeping it would fail every later request.
- Tool results are written back as **text** in `functionResponse.response.result`: Gemini reads a `$ref` member inside the response as a reference to a named response part, so a tool returning a JSON Schema (`$defs`/`$ref`) would fail the turn with `The referenced name "#/$defs/…" … does not match to a display_name`. Results are therefore never parsed into objects, are truncated past 512 KB, and fall back to text when the name is not among the tools declared in that turn.
- Tool schemas are sanitized into the OpenAPI subset Vertex accepts: `$schema`, `$id`, `$ref`, `$defs`, `$comment`, `additionalProperties`, `patternProperties`, `unevaluatedProperties`, `dependentSchemas`, `examples`, `default` and `oneOf` are stripped; `const` becomes a single-value `enum`; `type: [T, "null"]` becomes `type: T` plus `nullable: true`.

**Catalog and network**

- Automatic model list refresh: `publishers/google/models` is called first (`/v1`, then `/v1beta1`, 6 second timeout), non-chat families (image / tts / live / embedding / omni / nano-banana) are filtered out, and `supportedActions` must include `generateContent`. On success the result is merged with the configured catalog; on failure (an Express API key is often not allowed to list models) the configured catalog applies. Answers are cached for 24 hours.
- Model id normalization: `gemini-3-5-flash` → `gemini-3.5-flash`, so ids stored in older sessions still resolve.
- Unknown-model recovery: when a resumed session names an id the catalog does not know, the catalog is refreshed once before the id is refused.
- **Proxy**: `http://`, `https://`, `socks5://`, `socks5h://`, with optional username and password; `auto` reads `HTTPS_PROXY` / `ALL_PROXY` and honours `NO_PROXY`.
- Cross-provider history: tool calls produced by another model carry no Gemini signature and degrade to text, so switching models does not invalidate a session.
- Credential validation: a blank key or one containing characters an HTTP header cannot carry is rejected as `INVALID_CREDENTIAL` before the socket layer, instead of surfacing as an opaque HTTP 400.
- Diagnostics: when a request is refused, its shape (roles and part kinds, **never text**) is written to `dsh-google-cloud-rejection.json` in the system temp directory, so the rejected part combination can be read afterwards.

**User interface**

- The provider card renders in two postures: the "Add model provider" panel (`configured === false`) and the configured row (`configured === true`). Collapsed it shows a `project · key state · model count` summary; expanded it shows the field form.
- The form body is moved into DSH's own ProviderEditor container and takes over its Cancel / Apply buttons: Cancel discards the draft, Apply writes the credential first and the settings second, then collapses on success. DSH's own Edit button only drives its generic editor, which has no usable fields for a third-party provider.
- English and Chinese copy: `en` and `zh` dictionaries are registered under the `settings.googleCloud` namespace and follow the Harness language; `locale/*.json` supplies the title and description shown in the plugin list.

## Install and build

The source is TypeScript, built with [tsdown](https://tsdown.dev) (same layout as the official packages: `src/` → `lib/`):

```sh
npm install        # types and build tools only; nothing here is a runtime dependency
npm run build      # tsdown + scripts/wrap-client.ts → lib/index.js, lib/client.js
npm run typecheck  # tsc --noEmit
npm test           # offline: local HTTP / HTTP proxy / SOCKS5 proxy / discovery / card
```

Every test runs offline and needs no real credentials. `test/host-smoke.test.ts` starts a local fake Vertex endpoint and covers direct connections, an HTTP proxy with credentials, SOCKS5 with and without authentication, discovery and fallback, tool calls and their replay, a tool result carrying `$ref`, foreign tool history, a trailing unanswered model turn, text versus `functionResponse` ordering, and image plus attachment projection. `test/client-smoke.test.ts` loads the built `lib/client.js` and checks card registration, the collapsed summary, the save path, and that the key goes through the credentials service rather than the settings document.

Install this directory on the host as a profile bundle (restart Harness once afterwards):

```sh
dsh plugin --profile desktop add file:/absolute/path/to/dsh-gcloud
```

`lib/` ships with the repository, so the plugin works as installed. After changing the source, run `npm run build` and reinstall.

## Configuration

**Settings → Models → Google Cloud** row.

| Field | Notes |
| --- | --- |
| Project ID | Required. A project id or project number; becomes `projects/<id>` in the request path. |
| Location | Defaults to `global`. Gemini 4 Argon is served only from `global` and 404s elsewhere; a regional model needs its own location, such as `us-central1`. |
| Base URL | Optional. Empty derives the host from the location; fill in a full address to go through a gateway or private endpoint, and it becomes the prefix of every request path. |
| Proxy | Empty connects directly (or write `direct` / `none`); `http://host:port`, `https://host:port`, `socks5://host:port`, `socks5h://host:port`; with authentication `scheme://user:pass@host:port`; `auto` reads the environment. |
| API Key | Saved as `GOOGLE_CLOUD_API_KEY` through the credentials service, never into the settings file; leave the field blank to keep the current key. |
| Fallback model catalog | One model per line: `id \| display name \| context window \| max output tokens \| modalities`. The last three are optional, and modalities are `text,image`. These lines apply when the catalog endpoint is unavailable and are merged with discovery when it is available. |

Saving writes the profile's `cordis.patch.yml`, and the next model request uses the new values — no restart. Then pick a model under the **Google Cloud** group in the conversation's model selector.

You can also override the same row (`id: llm-google-cloud`) directly in `cordis.patch.yml`. Storing the configuration in the `providers` dictionary keyed by route id is the recommended form:

```yaml
- id: llm-google-cloud
  name: 'dsh-google-cloud-llm'
  config:
    provider: google-cloud
    providers:
      google-cloud:
        displayName: Google Cloud
        projectId: my-project-123456
        location: global
        baseURL: ''                      # empty: derive from the location
        proxy: socks5://127.0.0.1:1080
        apiKeyEnv: GOOGLE_CLOUD_API_KEY
        streamIdleTimeoutMs: 300000
        models:
          - id: gemini-4-argon
            name: Gemini 4 Argon
            contextWindow: 1048576
            maxTokens: 1048576
            inputModalities: [text, image]
```

The fields may also sit at the top level of the row (the older form, still supported): when `providers` has no entry for the route, top-level `projectId` / `location` / `baseURL` / `proxy` / `apiKeyEnv` / `models` / `streamIdleTimeoutMs` are read as the same configuration. The first save from the card migrates them into `providers.<route>` and clears the leftover top-level keys.

The default catalog holds 12 Gemini models: 4 Argon, 3.8 / 3.7 / 3.6 / 3.5 Flash, 3.5 / 3.1 Flash-Lite, 3.1 Pro (Preview), 3 Flash (Preview), 2.5 Pro / Flash / Flash-Lite, all with a 1M context window.

## Requests and proxying

```
POST {base}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse
x-goog-api-key: <API Key>
```

`base` is derived from the location by default (`global` → `https://aiplatform.googleapis.com`, the multi-region `us` / `eu` → `https://aiplatform.{location}.rep.googleapis.com`, anything else → `https://{location}-aiplatform.googleapis.com`) and can be overridden with `baseURL`. Direct and proxied calls share one Node HTTP/1.1 client (`fetch` does not route through a proxy on its own, so the plugin owns the connection):

- `http://` proxy: send `CONNECT` first, authenticate with `Proxy-Authorization: Basic`;
- `https://` proxy: establish TLS with the proxy, then `CONNECT`, then a second TLS layer with the target;
- `socks5` / `socks5h`: an RFC 1928 handshake, with no authentication or a username and password; the host name always goes to the proxy for resolution (equivalent to `socks5h`).

## Source layout

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host entry: registers the adapter and the provider directory entry, resolves credentials and image attachments |
| [`src/config.ts`](src/config.ts) | `Config` schema, defaults, the `providers` dictionary and the plain-value snapshot |
| [`src/transport.ts`](src/transport.ts) | Direct / HTTP CONNECT / SOCKS5 transport and requests |
| [`src/adapter.ts`](src/adapter.ts) | `LlmAdapter`: request projection, SSE state machine, thinking levels, signature replay, idle timeout |
| [`src/catalog.ts`](src/catalog.ts) | Model catalog discovery, filtering, caching and fallback |
| [`src/projection.ts`](src/projection.ts) | Messages, images and tool schemas → Gemini parts |
| [`src/errors.ts`](src/errors.ts) | Classifiable failures and API key validation |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: registers the card and mounts the locale dictionaries |
| [`src/client/card.tsx`](src/client/card.tsx) | Card component (collapsed summary + fields + save) |
| [`src/client/form.ts`](src/client/form.ts) | Draft state, credential probe, settings writes and the DOM bridge into the native editor |
| [`src/client/locales.ts`](src/client/locales.ts) | Card copy dictionaries (`en` / `zh`) |
| [`src/client/harness.ts`](src/client/harness.ts) | Typed wiring for the Harness client services and slots |
| [`locale/*.json`](locale) | Title and description shown in the plugin list (`en` / `zh`) |
| [`cordis.patch.yml`](cordis.patch.yml) | The profile bundle's inserted row (the row id is the settings namespace and must not be renamed) |
| [`scripts/wrap-client.ts`](scripts/wrap-client.ts) | Wraps the CJS bundle in the `window.__ModuleLoader__` form |
| [`test/host-smoke.test.ts`](test/host-smoke.test.ts) | Offline host tests (transport, catalog, projection, replay) |
| [`test/client-smoke.test.ts`](test/client-smoke.test.ts) | Offline client tests (built bundle loading, card save) |

## Failure codes

Every failure carries `code` and `failure` properties, which the Harness normalizer uses for retry classification.

| Code | When it happens |
| --- | --- |
| `MISSING_CREDENTIAL` | No project id, or the credential reference resolves to no key. |
| `INVALID_CREDENTIAL` | The key is blank or contains characters no HTTP header can carry. |
| `INVALID_CONFIG` | The proxy setting is not a URL, or its scheme is not http / https / socks5 / socks5h. |
| `UNKNOWN_MODEL` | The model is neither in the configured catalog nor in a refreshed discovery answer. |
| `INVALID_REQUEST` | The request has no visible content, the prompt was blocked by a safety policy, or the endpoint answered 4xx. |
| `AUTH` / `RATE_LIMIT` / `SERVER` | The endpoint answered 401·403 / 429 / 5xx. |
| `TIMEOUT` | Connecting, or waiting for the next SSE event, exceeded its limit. |
| `ABORTED` | The caller cancelled the request. |
| `TRANSPORT` | The endpoint is unreachable, or a proxy handshake failed. |
| `EMPTY_RESPONSE` | The stream ended cleanly without any visible content. |

## Known limitations

- **Express API keys only**: no Service Account or ADC support; the key comes from the credentials service or the environment.
- **The model list endpoint needs permission**: an Express API key may be refused by it, in which case the configured catalog applies and chat is unaffected.
- **Switching providers loses signatures**: tool calls from another provider carry no Gemini signature and degrade to text on replay.
- **`off` does not disable thinking**: it is only the lowest level. Gemini 3 / 4 use `thinkingLevel` (`off` → `MINIMAL` or `LOW`), and 2.5 Pro has a budget floor of 128.
- **Proxy credentials live in the URL**: they travel into the profile's `cordis.patch.yml` with the rest of the configuration; use environment variables or `auto` in sensitive setups.
- **One image size ceiling**: attachments beyond 4 MB or 2048×2048 are downscaled by `readImageRequest`; an image whose data cannot be resolved degrades to placeholder text.

## License

MIT. The build output inlines `@deepseek-ai/schemastery` (MIT) and its dependency `@deepseek-ai/cosmokit` (MIT).
