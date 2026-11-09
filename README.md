<div align="center">

<h1>OpenBao Secrets</h1>

<p>Secrets in OpenBao or HashiCorp Vault, typed at a terminal's password prompt, and stored for other plugins</p>

</div>

<br />

## Overview

OpenBao Secrets is a [Termix](https://github.com/Termix-SSH/Termix) plugin that connects Termix to [OpenBao](https://openbao.org) or HashiCorp Vault (the KV version 2 engine). People keep their own secrets and shared ones in a **Secrets** tab, by name. At a password prompt in a terminal, **Type a secret** types the value at the cursor without pressing Enter. Other plugins store, read and delete secrets in their own area through the service `openbao-secrets.store`.

A saved value is never sent to the browser to be shown. There is no reveal and no copy button.

Read the [docs](docs/index.md) to set it up and use it.

<br />

## Features

- One connection to OpenBao or Vault, set up by an admin with an AppRole
- The AppRole secret ID arrives in a response-wrapped token, is unwrapped once, and is kept sealed on the server
- Your secrets and shared secrets, in folders by `/`, with search
- A hidden value field that shows only dots, in every browser
- **Type a secret** from the terminal toolbar, a key binding or the command palette, with a caution every time
- A service for other plugins, each in its own area, with expiry times up to 30 days
- An hourly sweep deletes expired secrets
- Every read, write and delete in the audit log, never with the value

<br />

## Docs

- [Setup and use](docs/index.md)
- [Service for other plugins](docs/service.md), with a consumer example
- [Security](docs/security.md)
- [FAQ and limits](docs/faq.md)

<br />

## Requirements

Termix 26.11.0 or later (plugin API 1.13). OpenBao or HashiCorp Vault with a KV version 2 engine and the AppRole auth method, over https. **Type a secret** needs the SSH Terminal plugin.

<br />

## Install

From the community registry, once listed: Plugins, Browse.

From a release file: an admin turns on developer mode and uses Plugins, Install from file with the `.tmxplug` from [Releases](https://github.com/Coolroo/termix-plugin-openbao-secrets/releases). A file installed this way is unverified.

<br />

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run validate
npm run pack   # writes openbao-secrets-<version>.tmxplug
```

`.npmrc` sets `legacy-peer-deps`, because npm 10 cannot resolve the SDK's optional peer set without it.

<br />

## Support

Found a bug or have an idea? Open an [issue](https://github.com/Coolroo/termix-plugin-openbao-secrets/issues). This is a community plugin, looked after by its author, not the Termix team.

<br />

## License

Apache-2.0. See [LICENSE](LICENSE).
