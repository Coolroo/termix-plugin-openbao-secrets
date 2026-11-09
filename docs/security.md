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
- **The service** hands values to the calling plugin, as the acting user, after core checked **Use secrets**.

## Permissions

| Permission                                              | Lets a person                                                      | Default |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------- |
| Use secrets (`openbao-secrets.use`)                     | keep their own secrets, read and type shared ones, use the service | admin   |
| Manage shared secrets (`openbao-secrets.manage-shared`) | add, replace and delete shared secrets                             | admin   |

Every route checks permissions on the server. The user always comes from the session (`ctx.currentActor()`), never from a request body or a service argument.

## Audit

Every add, replace, delete, type, connect and disconnect is an audit line `openbao_secrets_<action>`, and every service call is `openbao_secrets_service_<method>`, with the area and the name and whether it worked. No line holds a value.

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
- While an input method (IME) composes text in the value field, the characters being composed show until they are committed.
