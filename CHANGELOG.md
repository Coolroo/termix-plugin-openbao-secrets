# Changelog

## 1.0.0

### Added

- A connection to OpenBao or HashiCorp Vault (KV version 2) over https, set in the plugin's admin settings: address, an optional CA, the KV mount, a base path and the AppRole role ID.
- **Connect** with a response-wrapped AppRole secret ID. It is unwrapped once and kept sealed on the server; a token that was already used gives "this token was already used or has expired: make a new one". **Disconnect** deletes it and revokes the plugin's token. **Test connection** logs in, writes, reads and deletes a probe, and reports each step.
- The **Secrets** tab: your secrets and the shared ones, in folders by `/`, with search. Add a secret, replace its value, or delete it. The value field shows only dots and the value is never shown again.
- **Type a secret** from the terminal toolbar, a key binding (Appearance, Keybindings) or the command palette. It types the value at the cursor without Enter, and always shows a caution.
- The service `openbao-secrets.store` 1.0.0 for other plugins: `status`, `bindPlugin`, `put`, `get`, `remove`, `list` and `removePrefix`, in the acting user's area, the shared area or the calling plugin's own area.
- Expiry times up to 30 days ahead, and an hourly sweep that deletes expired secrets.
- Permissions **Use secrets** and **Manage shared secrets**, both for admins by default.
- An audit line for every read, write and delete, with who, which secret and, for **Type a secret**, which terminal session and host. Never the value.
