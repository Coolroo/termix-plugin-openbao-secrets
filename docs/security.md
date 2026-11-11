---
title: Security
order: 2
---

# Security

OpenBao Secrets holds the key to a part of your OpenBao. This page says what it keeps, where values go, and why it needs each capability.

## What the plugin keeps

- **The AppRole secret ID**, in the plugin's own table, sealed with Termix's installation key (`ctx.secrets.seal`). It never sits in a setting, never goes to a browser and is never shown again. Only "connected since ..., by ..." is shown.
- **A random key for plugin areas**, sealed the same way. Each plugin's area key is an HMAC of the plugin id under it.
- **The OpenBao token**, in memory only. It is renewed at two thirds of its time, replaced by a new login when renewal fails, and revoked when the plugin stops or is disconnected.

Secret values are kept only in OpenBao.

## Connecting

- The secret ID arrives in a response-wrapped token. The plugin unwraps it once. OpenBao refuses a second unwrap, so a token that was copied somewhere is worthless once used, and a token someone else unwrapped first shows up as an error at Connect.
- Connect, Disconnect and Test connection need the core permission to manage plugins (`admin.plugins.manage`), and are refused for Termix API keys.

## Talking to OpenBao

Every request goes through `ctx.fetch`, Termix's guarded outbound HTTP:

- https only. An http address is refused when it is saved and again before every request.
- The configured host, and only it, may be a private or internal address (`allowPrivateHosts` is exactly that host). Every other private address stays blocked.
- The CA you set is trusted instead of the system store; without one the server's normal trust store is used. Certificate checks are never turned off.
- Redirects are refused, and every request times out after 10 seconds.
- OpenBao's own error text is never passed on, because it can echo input. Errors say which step failed and the HTTP status.

## Where a value goes

- **The Secrets tab** gets names, times, who made them and notes. It never gets a value: there is no reveal and no copy.
- **Add secret** and **Replace value** send the value from the browser to the plugin and on to OpenBao. The value field draws a dot for each character itself, so the value is never in the page as text, in every browser. Spell check, autocomplete, password managers, undo and dragging are off for it.
- **Type a secret** asks `POST /plugin-api/openbao-secrets/type` for one value. The answer has `Cache-Control: no-store`, is refused for Termix API keys, and is audited with who, which secret, the terminal session and the host. The browser types the value into the terminal with the SSH Terminal plugin's `terminal.sendToSession` (or `terminal.sendToActive`) with `run: false`, and drops it. It is never rendered, logged or stored in the browser.
- **Put in a variable** asks the same route, with `mode: "variable"` and the variable's name, which the server checks again. The server refuses a value with a line break or a control character, or longer than 4000 bytes, so a value can never end `read` early and run the rest as a command. The browser sends ` IFS= read -rs NAME`, then the value, each with `run: true` (typed as keys, then Enter), and drops it. The audit line says `mode variable` and the variable's name, never the value.
- **The service** hands values to the calling plugin, as the acting user, after core checked **Use secrets**.
- **App secrets** (`createAppField`, off by default) send a value from the calling plugin to OpenBao, at an allowed `<app>/<host>`. Nothing reads it back: the plugin reads only field names and versions there.

## Permissions

| Permission                                                | Lets a person                                                      | Default |
| --------------------------------------------------------- | ------------------------------------------------------------------ | ------- |
| Use secrets (`openbao-secrets.use`)                       | keep their own secrets, read and type shared ones, use the service | admin   |
| Manage shared secrets (`openbao-secrets.manage-shared`)   | add, replace and delete shared secrets                             | admin   |
| Create app secrets (`openbao-secrets.create-app-secrets`) | let plugins add new fields at the allowed app paths                | admin   |

Every route checks permissions on the server. The user always comes from the session (`ctx.currentActor()`), never from a request body or a service argument.

## Audit

Every add, replace, delete, type, connect and disconnect is an audit line `openbao_secrets_<action>`, and every service call is `openbao_secrets_service_<method>`, with the area and the name and whether it worked. No line holds a value.

## App secrets

The feature is off until an admin sets the **App secrets folder** and **Allowed app paths**. Then a bound plugin, acting for a user with **Use secrets** and **Create app secrets**, can add a field at an allowed `<app>/<host>`. The plugin refuses a field that exists, and its check-and-set write cannot replace one it did not see.

The OpenBao policy for it (`create` and `patch` on the data path, `read` on `subkeys` and `metadata`) never lets the plugin read, list or delete a value there. It cannot do everything, though:

- **A patch can replace or remove a field.** OpenBao has no capability for "add a field only": `patch` is a JSON merge patch, so it can also overwrite a field or remove one with `null`. The plugin never sends such a patch, but the policy alone does not stop one. If Termix's server or another plugin in its process were taken over, it could replace a value at an allowed path; it still could not read one. A replaced value stays in the secret's version history (`max_versions`, 10 by default), where an OpenBao admin can see and restore it; enough patches in a row push it out.
- **Parameter rules do not help.** `required_parameters`, `allowed_parameters` and `denied_parameters` see only the top-level request fields (`data`, `options`), not the fields inside `data` or the check-and-set number, and OpenBao's docs call them not supported for KV version 2.
- **Stricter, with less:** leave `patch` out of the policy. Then the plugin can only create a secret that does not exist yet (OpenBao asks for `update` to write an existing one), and adding a field to an existing secret fails with "OpenBao refused it (HTTP 403)".

Field names are visible to the plugin through `subkeys`. Keep secrets out of field names.

## Capabilities

| Capability         | Why                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------- |
| `db:own`           | One table, `state`, for the sealed secret ID and the sealed area key.                 |
| `secrets:own`      | `ctx.secrets.seal` and `unseal` for those two values.                                 |
| `network:outbound` | `ctx.fetch` to OpenBao, the one host in the settings.                                 |
| `network:serve`    | The routes the Secrets tab, the picker and the Connection setting call.               |
| `ui:surface`       | The Secrets tab, the Connection setting, the terminal button, picker and key binding. |

The plugin asks for nothing else: it reads no hosts, opens no SSH connection and reads no credentials. Typing into a terminal goes through the SSH Terminal plugin's own actions in the browser.

## Limits

- All plugins run in one Node process. The plugin area key stops honest mistakes and API misuse by other plugins, not a malicious plugin that reads memory.
- Anyone with **Use secrets** who acts through a consumer plugin reaches that plugin's area. The consumer decides who sees what in it.
- A typed secret is visible on screen if it is typed at a normal prompt instead of a password prompt, and then lands in shell history. The picker says so every time.
- **Put in a variable** types a command. Inside another program (an editor, a database shell, a remote desktop) that command and the value go to that program instead, and may show. The picker says to use it only at a bash or zsh prompt, every time. The variable stays in that shell until `unset`, and child processes see it only when it is exported.
- While an input method (IME) composes text in the value field, the characters being composed show until they are committed.
