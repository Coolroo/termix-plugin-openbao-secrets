# OpenBao Secrets 1.0.0: work in progress

Parked by the owner on 2026-11-07. Not built, not tested, not typechecked.
Spec: the lead's build spec (OpenBao Secrets, v1.0.0). Owner plan:
[Termix runbooks: secrets through OpenBao (plan)](https://docs.coolroo.dev/doc/termix-runbooks-secrets-through-openbao-plan-6e28YxZ5q3).

## Done (file by file)

- `.gitattributes`, `.gitignore`, `.npmrc`, `.nvmrc`, `.prettierignore`, `.prettierrc`, `LICENSE`, `tsconfig.json`, `vitest.config.ts`, `.github/**`: copied unchanged from termix-runbooks (dev-1.0.1), which copies the template.
- `package.json`: SDK pinned 1.0.22, same dev dependencies as Runbooks minus react-markdown and remark-gfm.
- `package-lock.json`: from Runbooks, renamed, pruned by `npm install --ignore-scripts`.
- `src/shared/names.ts`: name rules (1-4 segments of `[A-Za-z0-9._-]`, never `.` or `..`, at most 200 chars), prefix rules, value and note limits.
- `src/backend/config.ts`: admin settings (address https only, caPem, kvMount, basePath, roleId), checks for onValidate, `readConfig`, `hostOf` (the exact host for allowPrivateHosts).
- `src/backend/tables.ts`: one table `state` (name, sealed value, updatedBy, updatedAt): rows `secret-id` and `area-key`.
- `src/backend/state.ts`: read/write of `state`, values sealed with `ctx.secrets.seal`.
- `src/backend/openbao.ts`: OpenBao client over ctx.fetch (allowPrivateHosts = the address host only, tls.ca from caPem, redirect "error", 10 s timeout, no rejectUnauthorized:false): unwrap (spent token gives "this token was already used or has expired: make a new one"), AppRole login, lazy renew-self at 2/3 of the TTL, login again when renewal fails, one retry on 403, revoke-self, KV v2 write/read/metadata/list/destroy.
- `src/backend/plugin-areas.ts`: consumer identity handshake (below): `bind`, `verify`.
- `src/backend/secrets.ts`: areas and paths (`users/<id>`, `shared`, `plugins/<id>`, odd ids hashed), put (keeps createdBy), get (expired = deleted + null), describe, remove, list (recursive, max 2000), removePrefix, sweep.
- `src/backend/service.ts`: `secrets.store` implementation: status, bindPlugin, put, get, remove, list, removePrefix; permission checks (use, manage-shared); an audit line per call without the value.

## Left (in order)

1. `src/backend/connection.ts` (imported by service.ts, not written yet): status, connect (unwrap once, seal, store, try login), disconnect (revoke-self, delete row), test (login, write+read+delete a probe under `<basePath>/_probe/`, report each step).
2. `src/backend/routes.ts`: GET /status, GET /secrets (names only, both sections), POST/replace/DELETE secrets (shared needs manage-shared), POST /type (value only in that answer, `Cache-Control: no-store`, audited: who, which secret, session id, host id), admin routes behind `admin.plugins.manage` and refused for API keys.
3. `src/backend/index.ts`: wire it up, `ctx.services.provide("secrets.store")`, settings onValidate and onChange (reset the token), `ctx.schedule.every(1 h, sweep, { runNow: true })`, revoke-self on dispose.
4. `manifest.json` (id `openbao-secrets`, capabilities db:own, secrets:own, network:outbound, network:serve, ui:surface; settings incl. a `custom` field `connection`; permissions use, manage-shared; provides `secrets.store` 1.0.0 with permission `openbao-secrets.use`; keybindingActions `openbao-secrets.typeSecret`; uses `terminal.listSessions`, `terminal.sendToSession`, `terminal.sendToActive`, `terminal.toolbar`, `terminal.sidePanel`), `locales/en.json`.
5. `npm run migrations` for sqlite, postgres, mysql.
6. Frontend: Secrets tab (rail, hostless singleton; Your secrets / Shared, folders, search, add/replace with a masked textarea, delete; no reveal, no copy), admin settings component `connection` (Connect with wrapped token, connected since/by, Disconnect, Test connection), picker (caution always shown, POST /type, `terminal.sendToSession(id, value, { run: false })`, value dropped at once).
7. Terminal extension points (checked in SSH Terminal 1.3.0): toolbar button in slot `terminal.toolbar` (action gets TerminalSlotApi), picker in slot `terminal.sidePanel` via `slotApi.openSidePanel(id, props)`, keybinding action `openbao-secrets.typeSecret` (declared in manifest), palette entry. Note: `slotApi.sessionId()` is the backend SSH session id, but `terminal.sendToSession` takes the registry id, which is the tab id: resolve it with `terminal.listSessions` (visible + host match), else `terminal.sendToActive`. The terminal's keybinding run context gives no sessionId (only host and send), so the keybinding opens the Secrets tab in pick mode with the target resolved first.
8. Tests with a fake OpenBao (mock ctx.fetch) and frontend tests, as the spec lists.
9. README, CHANGELOG, docs/index.md, docs/security.md, docs/service.md (consumer example), docs/faq.md.
10. typecheck, test, validate, build, pack, format:check; commit on main.

## Consumer identity handshake

- Core never tells a provider who calls: `invokeGuarded` in Termix 26.11.0 `src/backend/plugins/service-registry.ts` (around lines 440-517) passes only the arguments and runs as the user; `consumerPluginId` goes to core's audit only (`ctx.ts` `writeServiceAudit`).
- Core does enforce that `ctx.registry.provide` and `revoke` take only keys under the caller's own id (`ctx.ts` registry block, `assertOwnRegistryKey`).
- So a consumer X provides a receiver function at `X.secretsStoreKey` and calls `secrets.store.bindPlugin("X")`.
- The provider consumes `X.secretsStoreKey` and calls it with X's area key = HMAC-SHA256(master, "plugin-area:X"); the master is 32 random bytes, sealed in the `state` table.
- X then passes `{ plugin: "X", key }` as the area; the provider recomputes the HMAC and compares in constant time.
- Plugin Y cannot forge it: Y cannot provide `X.secretsStoreKey` (namespace check), a bind for "X" hands the key to X's receiver and never returns it to Y, and the HMAC master never leaves the provider.
- Y can call X's receiver with junk (anyone may consume): that is a denial of service on X only. X should accept a key only while its own bindPlugin call is in flight.
- Limit: all plugins share one Node process, so this guards against honest mistakes and API misuse, not against a malicious plugin that patches memory.

## Open questions

- Service name `secrets.store` does not start with the plugin id, as the services doc advises. The spec asks for it; keep it?
- The service permission is `openbao-secrets.use`, so a person running a Runbooks step that uses the plugin area needs Use secrets too. Is that wanted?
- S2 (7 days) is for Runbooks to set as `expiresAt`; the service does not cap expiry. Confirm.
- The hidden multi-line field uses CSS `-webkit-text-security`; check Firefox support before release.
- `npm install` here needs `--ignore-scripts` (no Python for node-gyp; better-sqlite3 ships prebuilds).

## Next command

```bash
cd /workspace/termix-openbao-secrets && git switch wip-1.0.0 && flock /home/paseo/.heavy-job.lock npm install --ignore-scripts
```

Then write `src/backend/connection.ts` (step 1 above).
