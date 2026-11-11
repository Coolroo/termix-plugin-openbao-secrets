# Changelog

## 1.0.5

### Added

- **App secrets**, off by default. The service `openbao-secrets.store` is now version 1.1.0, with `createAppField(caller, app, host, field, value)`: a plugin bound to the store adds one new field at `<app secrets folder>/<app>/<host>`, for another program that reads its secrets there. It never reads a value and never replaces a field: it reads the secret's field names (KV `subkeys`), refuses a field that exists, and writes with check-and-set (0 for a new secret, the checked version for a new field by JSON merge patch), trying once more after a lost race. A secret whose newest version is deleted or destroyed is refused.
- Admin settings **App secrets folder** (a folder in the KV mount, outside the base path) and **Allowed app paths** (one `<app>/<host>` per line). Both are empty by default, and the feature is off until both are set.
- The permission **Create app secrets** (`openbao-secrets.create-app-secrets`), for admins by default. Callers need it as well as **Use secrets**.
- An audit line for every try: the user, the calling plugin, the path and the field, never the value.
- Docs: the OpenBao policy lines for it (`create` and `patch` on data, `read` on `subkeys` and `metadata`), and what that policy cannot stop (a `patch` can replace a field; the plugin refuses to, the policy alone does not).

## 1.0.4

### Added

- **Put in a variable** in the secret picker, beside **Type at the cursor**. It asks for a variable name (letters, digits and `_`, not starting with a digit; the default comes from the secret's name, so `runbook-test` gives `RUNBOOK_TEST`). Then it types ` IFS= read -rs NAME` with a space first, Enter, the value and Enter. `read -s` takes the value without showing it, and the value is input, not a command, so it never goes into history; the space first keeps the `read` line out of history where `HISTCONTROL` has `ignorespace`. Use `"$NAME"` in commands, and run `unset NAME` when done. A caution shows every time: use it only at a bash or zsh prompt. The audit line names the secret, the terminal session and host, the mode `variable` and the variable, never the value.
- A secret with more than one line, a control character, or more than 4000 bytes cannot go in a variable: one line of `read` would not hold it. The picker says so and types nothing.

### Changed

- Picking a secret now asks what to do with it: **Type at the cursor** (as before) or **Put in a variable**.

## 1.0.3

### Fixed

- The **Replace value** and **Delete** buttons on a secret's row are icons, as in Termix's own lists. They held words that spilled out of the buttons and over the row, most of all on a phone. Each icon keeps its name as a tooltip and for screen readers.

## 1.0.2

### Fixed

- **Add secret** and **Replace value** work with phone keyboards. An Android keyboard composes a whole word before it hands it over, and the old dots-only field missed those words, so **Add** stayed off. The value field is now a plain text field: typing, paste and autofill all set the value.

### Changed

- The value shows while you type, so you can check it before you save. A **Hide** button draws it as dots, and **Show** brings it back; neither changes the value. Once saved, a value is still never sent to the browser to be shown.

## 1.0.1

### Fixed

- Adding a secret when OpenBao accepts the value but refuses its metadata (for example a policy without create and update on the KV metadata path) no longer leaves the value behind with no expiry or creator. The new secret is taken back, and adding it again works once the policy is right.

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
