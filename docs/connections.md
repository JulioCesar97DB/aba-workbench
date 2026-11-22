# AI connections

How ABA Workbench connects to ChatGPT and to Claude, where it keeps what that takes, and what it sends to each provider. Both are set up on one screen, in Settings under "AI connection" (`src/renderer/src/screens/Connections.tsx`); the main process does the rest (`src/main/connections.ts`). Connecting only proves the connection works: drafting sections with it, choosing a model and showing costs come later.

## ChatGPT: Sign in with ChatGPT

ChatGPT connects with the user's own ChatGPT plan, with no API key, through OpenAI's flow for open-source apps that run on the user's computer (owner's decision; the repository is public under Apache-2.0). It follows OpenAI's documentation, read in full on 2026-11-22: [overview](https://developers.openai.com/siwc/token-sharing-open-source), [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) and the [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines). The code is in `src/main/chatgpt-oauth.ts` (the OAuth calls), `src/main/oauth-callback.ts` (the loopback listener) and `src/main/chatgpt-session.ts` (the steps below).

### Signing in, step by step

1. The user chooses **Continue with ChatGPT**. One sign-in runs at a time; a second click is answered "already signing in".
2. The app makes sure this computer has its `ext_agent_host_id`, `urn:uuid:` and a random version 4 UUID, saved in the credentials file before it is first sent and never changed (owner's decision).
3. It makes a fresh `state`, OIDC `nonce` and PKCE verifier (64 random characters; the challenge is its SHA-256, base64url, `S256`), and starts a one-time HTTP listener on `127.0.0.1`, port 1455; if another app holds 1455 (Codex CLI uses it too), a port the system picks (owner's decision). The screen then says so, since OpenAI may refuse a port other than the one of the first registration; OpenAI documents that only the port may vary.
4. It opens the system browser (never a window of its own) at `https://auth.openai.com/api/accounts/authorize` with `response_type=code`, `redirect_uri=http://127.0.0.1:<port>/auth/callback`, `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256` and `ext_agent_host_id`. A first registration sends `client_id=dynamic_agent_client` and `agent_name_hint=ABA Workbench`; a later sign-in sends the client id OpenAI issued, plus the last ID token as `id_token_hint` and the email as `login_hint` when the app still has them (not after a sign-out). Asking again after the user declined plan use adds `prompt=consent`.
5. The user signs in and approves in the browser; OpenAI sends the browser back to the listener. The listener accepts one request only: a `GET` of `/auth/callback`, addressed to `127.0.0.1:<its port>` (the `Host` header; a page on another name that resolves to 127.0.0.1 is refused), sent as a top-level navigation (no `Origin` header; `Sec-Fetch-Mode`, when present, `navigate`; so a script on another site cannot call it), carrying this attempt's `state` (compared in constant time). Anything else gets a short page and is ignored, and the attempt keeps waiting. After the first valid callback the listener stops answering (410) and closes. Its pages carry `Content-Security-Policy: default-src 'none'`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
6. A first registration's callback carries the client id OpenAI issued: it is saved at once (client id only, no account yet), so if anything after this fails, the next attempt reuses it instead of registering another app (OpenAI: "start a fresh authorization with the issued client ID retained for this attempt"). `error=access_denied`: OpenAI did not give access; nothing is exchanged. Its answer does not say why: the user did not allow it, or the account has no plan apps can use (see [A free ChatGPT account](#a-free-chatgpt-account)). A first registration whose callback has no issued `client_id`, or a later one naming a different client id, is refused.
7. The code is exchanged at `https://auth.openai.com/api/accounts/oauth/token` (form-encoded `authorization_code` grant with the issued client id, the code, the PKCE verifier, the same `redirect_uri` and `resource`; no client secret). **Cancel sign-in** also stops this exchange and the key fetch below; every call to the auth server gives up after 30 seconds.
8. The ID token is verified with [jose](https://github.com/panva/jose) (owner's decision): RS256 signature against OpenAI's published keys (`/.well-known/jwks.json`, fetched again once if the key id is new; a fetch that fails reads as "OpenAI could not be reached", never as a bad token), issuer `https://auth.openai.com`, audience the issued client id, expiry (5 seconds' tolerance), and the nonce of this attempt. A later sign-in must name the same account (`sub`) as before, or nothing changes ("different account"). Tokens the app then drops (a different account, an ID token that fails, a sign-in that cannot be saved) are revoked with OpenAI first.
9. The token response's scopes decide plan use: without `chatgpt.tokens.use.direct` the sign-in is kept but shows **Needs attention**, explaining the two ways on that OpenAI names: sign in again and allow it, or use another way to pay (here, Claude with an API key).
10. The tokens, the issued client id, the account (`sub`, email, name) and the scopes are saved in the credentials file. The first time a sign-in ends with plan use allowed on this computer, a dialog says that the app uses the ChatGPT plan, with a link to ChatGPT's usage settings (OpenAI's UI guidelines); "Got it" is remembered in the settings file (`chatgptWelcomeShown`), so it never shows again, also after another account. The dialog always closes: if the settings file cannot be written, it is remembered for this run and the card says it may show again next time.

Every step that fails is written to the main process's log by name. Nothing from the network is written as it is: an OAuth error code is logged only when it is one the app knows (RFC 6749's, OpenID Connect's, OpenAI's refresh errors; `KNOWN_OAUTH_CODES` in `src/main/chatgpt-oauth.ts`), anything else as `unknown`; OpenAI's `error_description` only as its length; the granted scopes only as whether the plan scope was there. So a token, a code, a state, an email or a forged log line cannot reach the log. For example: `ChatGPT sign-in: the callback arrived (with error access_denied).`, `ChatGPT sign-in: the code exchange failed (invalid_grant, HTTP 400).`, `ChatGPT sign-in: a request to the callback address was refused (state).`.

The attempt ends after 10 minutes with no answer (the user closed the browser, say), or when the user chooses **Cancel sign-in**; the listener then closes and nothing is saved.

### While signed in

- **Refresh.** An access token lasts an hour. While the app runs it is refreshed 5 minutes before it expires (not before `earliest_refresh_at`, unless the token has expired; the timer never fires sooner than 30 seconds after the last one), and before any use within those 5 minutes: a form-encoded `refresh_token` grant with the issued client id and `resource`, no scope. The new access token, its expiry, the scopes and the rotating refresh token are saved together. Refreshes are one at a time (two callers share one), so a rotating token is never used twice. If the save fails (a full or read-only disk), the new tokens are kept in memory and used from then on (the replaced refresh token is never sent again), the card shows **Needs attention** (the sign-in will be lost when the app quits), and the save is tried again at the next use or timer tick, and once more when the app quits. A network failure or a 5xx keeps the tokens (a token not yet expired keeps working) and tries again 5 minutes later. `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused` or `invalid_client` end the session: the tokens are removed, the issued client id and account stay, and ChatGPT shows **Needs attention** with **Sign in again**.
- **Check connection** asks for the account's model list (`GET https://api.openai.com/v1/models` with the access token; free, and the same list the model picker will use: `models[]`, `visibility: "list"`, in the server's order). A 401 gets one forced refresh and one more try. A refresh OpenAI refuses for good ends the session as above; a refresh that works proves the session is alive, so a second 401 keeps the tokens and is reported as an error (OpenAI: a 401 means "check the selected ChatGPT account and granted scopes"). `subscription_sharing_user_not_eligible` marks the connection **Needs attention** with the free-account message below, without repeating the request or looping through sign-in.
- **Manage usage in ChatGPT** opens `https://chatgpt.com/settings/usage` in the browser.

### Signing out, and another account

**Sign out** (owner's decision): requests stop; the refresh token is revoked at `https://auth.openai.com/api/accounts/oauth/revoke` (`token`, `token_type_hint=refresh_token`, the issued client id; an empty 200 confirms), retried after 1 and 3 seconds on a network failure or a 5xx; then the access, refresh and ID tokens, the email and the name are removed. The issued client id, the account's `sub` and the host id stay, so the next sign-in returns to the same registration without adding another app to the user's ChatGPT settings. If OpenAI did not confirm the revocation, the app signs out anyway and says so, pointing to ChatGPT's settings to disconnect it there. If the signed-out state cannot be written, the app is signed out for this run and writes it at the next save or when it quits.

**Use a different ChatGPT account** (shown when signed out, after a session ended, or after a first registration that did not finish) forgets the saved registration; the next sign-in registers again with `dynamic_agent_client`. The host id stays: it belongs to this computer.

### When ChatGPT does not allow its plan

OpenAI's pages do not say which ChatGPT plans can be used by apps, nor what a free account gets at sign-in; they name Plus and Pro only when describing usage limits, and say a refusal can also come from the account's workspace or a policy. So the app says only what happened, offers a paid plan as a possibility, never as a fact, and offers Claude instead (owner's decision, 2026-11-22). Each first sentence is "ChatGPT did not allow ABA Workbench to use this account's plan" ("ChatGPT no permitió que ABA Workbench usara el plan de esta cuenta"):

| What OpenAI does | What the app shows |
| --- | --- |
| Ends the sign-in with `error=access_denied` (nothing is exchanged) | Not connected, and "ChatGPT did not allow ABA Workbench to use this account's plan, so nothing was saved. Access may not have been allowed in the browser, or a paid ChatGPT plan, such as Plus or Pro, may be needed. You can sign in again, or connect Claude with an API key instead." |
| Signs in without the `chatgpt.tokens.use.direct` scope | Needs attention: "You signed in, but ChatGPT did not allow ABA Workbench to use this account's plan. It may not have been allowed in the browser, or a paid ChatGPT plan, such as Plus or Pro, may be needed…", with **Sign in again and allow** (`prompt=consent`) and **Sign out**. |
| Signs in with the scope, then answers `subscription_sharing_user_not_eligible` (403) | Needs attention: "ChatGPT did not allow ABA Workbench to use this account's plan. A paid ChatGPT plan, such as Plus or Pro, may be needed, or the account's workspace or a policy may not allow it…", with **Sign out** only: OpenAI asks apps not to repeat the request or loop through sign-in. It is kept on the saved sign-in (`planNotEligible`), so a restart still shows it; the next sign-in, a sign-out or a check that works clears it. |

The owner's first real sign-in (2026-11-22) used a ChatGPT account with no paid plan. It was approved in the browser, and the app saved no tokens and stayed not connected. The app did not log which step ended it then; it now logs the step for every failure.

### Requests that spend the ChatGPT plan

`src/lib/providers/openai.ts` takes the access token as its credential (`{ kind: "chatgpt", accessToken }`) and sends it as the SDK's bearer token to the public Responses endpoint, `https://api.openai.com/v1/responses`, never ChatGPT's own backend. The request follows the preview's rules: `stream: true` and `store: false` always, `input` as an array, the rules as a developer message (never `system`), and none of the fields OpenAI lists as unsupported (`max_output_tokens`, `prompt_cache_retention`, `metadata`, `temperature`, `top_p`, `truncation`, `user` and the others; `tests/openai.test.ts` checks each). The cache's `ttl` is left out too, since it replaces `prompt_cache_retention`. A generation counts as complete only on `response.completed`. The SDK does not retry (a retried 429 would spend the plan's limits again). OpenAI's plan errors (`subscription_sharing_usage_limit_exceeded`, `subscription_sharing_user_not_eligible`, `subscription_sharing_unsupported_capability` and the rest) become their own messages, also when they arrive after the stream began. Pre-warming the cache (a request that does not stream) is refused with this credential. With an API key (`{ kind: "api-key" }`, development and `pnpm phase0`) the requests are as before.

## Claude: an API key

Anthropic does not let other apps offer Claude.ai sign-in, so Claude connects with an API key the user creates in the Anthropic Console and pastes (`src/main/claude-key.ts`).

- The pasted text is trimmed and must look like a Claude key (`sk-ant-`, visible ASCII, at most 400 characters); anything else, an OpenAI key say, is refused on screen and never sent.
- **Check and save** asks Anthropic for its model list with the key (`GET https://api.anthropic.com/v1/models`, free). The key is saved only if Anthropic accepts it. A 401 or 403 says plainly that Anthropic did not accept it; no answer, or another error, says so and saves nothing.
- **Check connection** repeats that call. A key Anthropic no longer accepts (deleted in the Console) shows **Needs attention** until it is replaced or removed (for this run of the app; the next start shows it as connected until a check or a request says otherwise).
- **Remove key** deletes it from the credentials file.

## Where credentials live

`credentials.json`, in the app's own data folder next to `settings.json` (`~/Library/Application Support/ABA Workbench` on macOS, `%APPDATA%\ABA Workbench` on Windows, `~/.config/ABA Workbench` on Linux); `src/main/credentials.ts`. No OS keychain encryption for now (owner's decision).

- **Owner-only.** macOS and Linux: created with mode `0600`, so it is never readable by others, not even for an instant; a file found with wider permissions is made `0600` again when read, whether or not it can be parsed. Windows: an access list with one entry, full control for the current user's SID (from `whoami /user`), nothing inherited, set with Windows' own `icacls` (run from `System32` by its full path) on the empty temporary file before any secret is written to it (owner's decision); the rename keeps it. If that fails the save fails: a secret is never written to a file others may read. `src/main/owner-only.ts`.
- **Durable**, like the settings file: a temporary file next to it, flushed, renamed over it, the folder flushed (`src/main/durable-write.ts`). A temporary credentials file a crash left behind is removed at the next start.
- **Strict reading**, like a case's data file: UTF-8 with nothing replaced, no repeated keys, numbers exact, then Zod. A file that is damaged, not a plain file (a folder, a link), larger than 1 MB, unreadable, or from a newer version of the app is **never written to**: both connections show as not connected, Settings explains why, and nothing can be connected until the user chooses **Start over…** and confirms. That renames the file to `credentials.json.unreadable-<UTC time>` (`2026-11-22T18-05-48Z`, no colons, for Windows) in the same folder, makes it owner-only (`0600`, or the current user's access list on Windows) whatever its mode was, and never deletes it (owner's decision); then the app starts with no saved connections.

Version 1 (owner's decision on the format, 2026-11-22). Keys this version does not know are kept when it saves; a newer version raises `version` and adds a step to `MIGRATIONS`.

```json
{
  "version": 1,
  "hostId": "urn:uuid:5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10",
  "claude": { "apiKey": "sk-ant-...", "savedAt": "2026-11-22T18:00:00.000Z" },
  "chatgpt": {
    "issuer": "https://auth.openai.com",
    "clientId": "oaiapp_...",
    "subject": "<sub of the validated ID token>",
    "email": "user@example.com",
    "name": "Ana Pérez",
    "idToken": "...",
    "accessToken": "...",
    "refreshToken": "...",
    "tokenType": "Bearer",
    "expiresAt": "2026-11-22T19:00:00.000Z",
    "earliestRefreshAt": null,
    "scopes": ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"],
    "savedAt": "2026-11-22T18:00:00.000Z"
  }
}
```

`claude` and `chatgpt` are `null` when not connected. After a sign-out `chatgpt` is `{ "issuer", "clientId", "subject", "signedOut": true }` (with no `subject` when a first registration did not finish: the client id is kept for the retry); after a session ended on OpenAI's side it also has `"sessionEnded": true`, which shows as needing a new sign-in. `email` and `name` are `null` when the ID token has none; the email is only ever sent back to OpenAI as `login_hint`, and the name is the one thing the interface shows of the account.

## What the app sends, and what it never sends

| To | What | Never |
| --- | --- | --- |
| `auth.openai.com` (system browser) | The authorize request above. | A token in a URL, other than the ID token as `id_token_hint`, which OpenAI's docs ask for and which goes only to this endpoint. |
| `auth.openai.com` (the app) | The code exchange, refreshes, revocation; a GET of the published keys. | A client secret (there is none). |
| `api.openai.com` | With the sign-in: the model list (the connection check). Later, the drafting requests described above. | Anything from a case while connecting; `store: true`. |
| `api.anthropic.com` | The model list with the pasted key (the check). | Anything from a case while connecting. |
| `chatgpt.com` (system browser) | Opening the usage settings page. | Anything at all from the app. |

Every request from the main process goes only to those addresses and never follows a redirect (`pinnedFetch` in `src/lib/providers/endpoints.ts`, now used for `https://auth.openai.com` too). Keys and tokens never reach the interface, are never logged, never appear in an error message and are never written anywhere but the credentials file: the interface learns states (connected, not connected, signing in, needs attention), the account's display name, and fixed messages; the main process's log names only error codes, never a key, a token, a path or a response body.

## Tests

No test makes a real network call or needs a real account. The window tests' windows let the computer's real mouse pass through (`setIgnoreMouseEvents`): a person using the computer while they run cannot move the hover they rely on. `tests/credentials.test.ts` (the file format, damaged and newer files, owner-only permissions, Start over, leftover temporary files, Windows' access list on Windows), `tests/chatgpt-sign-in.test.ts` (PKCE, the authorize address, ID-token checks, the callback's checks: wrong state, replay, a second callback, another origin, a rebinding host; the whole sign-in against a faked OpenAI; refresh, terminal refresh errors, revocation, sign-out, another account, a taken port), `tests/connections.test.ts` (the Claude key and the states), `tests/openai.test.ts` (the request shapes with an API key and with the sign-in, plan errors). `e2e/connections.e2e.ts` drives the screen with both providers faked inside the main process (`stubConnections` in `e2e/app.ts`, which also refuses any other request): sign-in through a faked browser, a declined permission, a revoked session, cancelling, the Claude key, a damaged file and Start over, hostile input, Spanish. `e2e/screenshots.e2e.ts` takes screenshots of every state in both languages when `ABA_SCREENSHOTS` names a folder.
