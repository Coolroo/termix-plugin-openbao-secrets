---
title: Service for other plugins
order: 1
---

# Service for other plugins

OpenBao Secrets provides the service `openbao-secrets.store`, version 1.0.0. Another plugin uses it to keep secrets in OpenBao without a connection of its own: Runbooks keeps the values a runbook asks for, for example.

## Use it

Declare it in your manifest. Mark it optional, so your plugin works without it:

```json
"requires": [
  { "service": "openbao-secrets.store", "versionRange": "^1.0.0", "optional": true }
]
```

Then get it in your backend. While OpenBao Secrets is not running, the handle is an empty object:

```ts
const store = ctx.services.get<SecretsStore>("openbao-secrets.store");
if (!("put" in store)) {
  // OpenBao Secrets is not installed or not running.
}
```

Core runs every call as the acting user and checks first that the user holds **Use secrets** (`openbao-secrets.use`). Call it from a request, or from background work wrapped in `ctx.asUser`. A user without the permission gets an error, and so does a call with no acting user.

## Methods

All methods are async. A value travels only in an argument or a result: never in an error, a log line or an audit line.

| Method                             | Answers                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `status()`                         | `{ connected, backend: "openbao-kv2" }`                                   |
| `bindPlugin(pluginId)`             | nothing; hands your area key to your receiver (below)                     |
| `put(area, name, value, options?)` | nothing; `options` is `{ expiresAt?, note? }`                             |
| `get(area, name)`                  | the value, or `null` when there is none or it has expired                 |
| `remove(area, name)`               | `true` when there was a secret                                            |
| `list(area, prefix?)`              | `[{ name, createdAt, updatedAt, createdBy, expiresAt, note }]`, no values |
| `removePrefix(area, prefix)`       | how many secrets were deleted; `""` empties the area                      |

- A name is 1 to 4 parts joined by `/`, each part letters, digits, `.`, `_` and `-`, at most 200 characters. A prefix is a name, with or without a trailing `/`.
- `put` replaces the value and the options. `createdBy` stays the user who first stored it.
- `expiresAt` is an ISO time in the future and at most 30 days ahead; later is refused with "expiresAt is more than 30 days ahead: the limit is 30 days". An expired secret reads as `null` and is deleted within the hour.
- `note` is short (200 characters), not secret, and shows in the Secrets tab for the user and shared areas.
- `list` walks at most 2000 secrets.

## Areas

| `area`            | Whose                     | Read needs  | Write needs                        |
| ----------------- | ------------------------- | ----------- | ---------------------------------- |
| `"user"`          | the acting user's own     | Use secrets | Use secrets                        |
| `"shared"`        | everyone's shared secrets | Use secrets | Use secrets, Manage shared secrets |
| `{ plugin, key }` | your plugin's own area    | Use secrets | Use secrets                        |

The user and shared areas are the ones people see in the Secrets tab. Your plugin's area is not shown there. Any user with **Use secrets** who acts through your plugin reaches the same plugin area, so keep per-user or per-run data under your own prefixes (`rb-12/...`) and check access yourself.

### How the plugin area knows it is you

Core does not tell a provider which plugin is calling, so OpenBao Secrets cannot trust a plugin id given as an argument. Instead it hands each plugin a key, through a receiver that only that plugin can have registered:

1. In `activate`, provide a receiver at `<your plugin id>.secretsStoreKey` in `ctx.registry`. Core lets a plugin provide registry keys under its own id only, so no other plugin can put a receiver there.
2. Call `bindPlugin("<your plugin id>")`. OpenBao Secrets calls your receiver with your area key. The key is never returned to the caller, so another plugin that calls `bindPlugin` with your id only sends your key to you.
3. Pass `{ plugin: "<your plugin id>", key }` as the area. The key stays the same across restarts.

Anyone may call your receiver, so take a key only while your own `bindPlugin` call is in flight.

## Example

A consumer plugin with the id `runbooks`, storing a value for a week and deleting a run's values when it is done:

```ts
let binding = false;
let key: string | null = null;
ctx.registry.provide("runbooks.secretsStoreKey", (given: string) => {
  if (!binding) throw new Error("not binding");
  key = given;
});
binding = true;
try {
  await store.bindPlugin("runbooks");
} finally {
  binding = false;
}
const area = { plugin: "runbooks", key: key! };
const week = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
await store.put(area, "rb-12/db-password", password, { expiresAt: week });
const value = await store.get(area, "rb-12/db-password");
await store.removePrefix(area, "rb-12/");
```

The types, to copy into your plugin:

```ts
type Area = "user" | "shared" | { plugin: string; key: string };

interface SecretsStore {
  status(): Promise<{ connected: boolean; backend: string }>;
  bindPlugin(pluginId: string): Promise<void>;
  put(
    area: Area,
    name: string,
    value: string,
    options?: { expiresAt?: string | null; note?: string | null },
  ): Promise<void>;
  get(area: Area, name: string): Promise<string | null>;
  remove(area: Area, name: string): Promise<boolean>;
  list(
    area: Area,
    prefix?: string,
  ): Promise<
    Array<{
      name: string;
      createdAt: string | null;
      updatedAt: string | null;
      createdBy: string | null;
      expiresAt: string | null;
      note: string | null;
    }>
  >;
  removePrefix(area: Area, prefix: string): Promise<number>;
}
```

## Errors

Errors are plain `Error`s with a short message: a bad name, a missing permission, a wrong area key, OpenBao not connected, or OpenBao refusing ("Write failed: HTTP 403"). None carries a value.

## Audit

Core writes `plugin_service_openbao-secrets_store_<method>` for every call, naming your plugin. OpenBao Secrets adds `openbao_secrets_service_<method>` with the area and the name, and whether the call worked.
