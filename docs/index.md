# OpenBao Secrets

OpenBao Secrets keeps secrets in OpenBao or HashiCorp Vault and lets you use them in Termix without seeing them. You keep your own secrets and the team's shared secrets in the **Secrets** tab. At a password prompt in a terminal, **Type a secret** types one at the cursor. Other plugins store their secrets through the same connection, each in its own area.

A saved value is never shown again: not in the tab, not in the browser, not in a log.

## Set up OpenBao

The plugin logs in with an AppRole and uses one KV version 2 engine. The commands use `bao`; `vault` takes the same arguments.

1. Turn on a KV version 2 engine, if you have none: `bao secrets enable -path=kv kv-v2`.
2. Write a policy that lets the plugin use one folder of it. With the KV mount `kv` and the base path `termix` (the defaults):

   ```hcl
   path "kv/data/termix/*" {
     capabilities = ["create", "read", "update"]
   }
   path "kv/metadata/termix/*" {
     capabilities = ["create", "read", "update", "delete", "list"]
   }
   ```

   `bao policy write termix-secrets termix-secrets.hcl`

3. Make the AppRole:

   ```bash
   bao auth enable approle
   bao write auth/approle/role/termix token_policies=termix-secrets token_ttl=1h token_max_ttl=24h
   bao read auth/approle/role/termix/role-id
   ```

   The role ID is not secret. Keep it for the settings below.

## Turn it on

1. Install the plugin and grant its capabilities. Termix lists them on install; [Security](security.md) says why each one is needed.
2. Open Settings, Plugins, **OpenBao Secrets**, and fill in:
   - **OpenBao address**: `https://` and the host and port, like `https://bao.example.com:8200`. Plain http is refused. A private or internal address works: the plugin may reach exactly this host.
   - **CA certificate (PEM)**: only when OpenBao's certificate comes from your own CA. Empty uses the server's normal trust store, which includes `NODE_EXTRA_CA_CERTS`.
   - **KV mount** and **Base path**: `kv` and `termix` unless you chose others.
   - **AppRole role ID**: from step 3 above.

   Save.

3. Make a response-wrapped secret ID. It is good for one use and ten minutes:

   ```bash
   bao write -wrap-ttl=10m -f auth/approle/role/termix/secret-id
   ```

   Copy the `wrapping_token` from the answer. In **Connection**, paste it and press **Connect**. The plugin unwraps it once, keeps the secret ID sealed on the server, and logs in. The status reads "Connected since ..., by ...".

4. Press **Test connection**. It logs in, writes a probe under `<base path>/_probe/`, reads it back and deletes it, and shows each step.
5. Give the people who keep and type secrets the **Use secrets** permission, and the people who look after the shared secrets **Manage shared secrets**. Admins have both by default.

A wrapping token that was already used, or has expired, gives "this token was already used or has expired: make a new one". Make a new one. If someone else unwrapped your token first, OpenBao refuses it the same way: make a new secret ID and look into who did.

**Disconnect** deletes the stored secret ID and revokes the plugin's token. The secrets stay in OpenBao.

## Keep secrets

Open **Secrets** from the sidebar. It has two lists: **Your secrets**, which only you see, and **Shared**, which everyone with **Use secrets** sees.

- **Add secret**: a name, the value and an optional note. A name is up to 4 parts joined by `/`, like `db/prod/root`; each part is letters, digits, `.`, `_` and `-`. The parts show as folders. The value field shows a dot for each character and keeps the line breaks, so you can paste a key or a certificate. The note is not secret and shows in the list.
- **Replace value**: a new value for the same name. The note and expiry stay.
- **Delete**: deletes every version of the secret, after a confirm.

Only people with **Manage shared secrets** add, replace or delete shared secrets.

## Type a secret into a terminal

In a terminal, press **Type a secret** in the toolbar. The picker opens beside the terminal with this caution:

> The secret is typed at the cursor. Use it at a password prompt: at a normal prompt it shows on screen and in history.

Pick a secret. It is typed where the cursor is, without Enter. Press Enter yourself.

You can also bind a key to **Type a secret** in Appearance, Keybindings, or run it from the command palette. Both open the Secrets tab on the picker, and go back to your terminal after the pick.

Each pick is in the audit log: who, which secret, which session and host. The value is not.

## Expiry

A secret can have an expiry time, up to 30 days ahead. Other plugins set it through the service; the Secrets tab shows it. An expired secret reads as gone, and an hourly sweep deletes it from OpenBao.

## Where secrets live

Under the KV mount and the base path:

| Area            | Path                                      |
| --------------- | ----------------------------------------- |
| Your secrets    | `<base path>/users/<your user id>/<name>` |
| Shared          | `<base path>/shared/<name>`               |
| A plugin's area | `<base path>/plugins/<plugin id>/<name>`  |
| Test probe      | `<base path>/_probe/<random>`             |

The value is the KV field `value`. The KV custom metadata holds `createdBy`, and `expiresAt` and `note` when set.

## For plugin authors

[Service for other plugins](service.md) describes `openbao-secrets.store`.
