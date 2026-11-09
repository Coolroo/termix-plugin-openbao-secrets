---
title: FAQ and limits
order: 3
---

# FAQ and limits

## Does it work with HashiCorp Vault?

Yes. It uses the KV version 2 engine, the AppRole auth method and response wrapping, which OpenBao and Vault share.

## Can I see a secret's value after I save it?

No. Nothing in Termix shows it again. To change it, use **Replace value**. To read it, use OpenBao.

## Why can't I paste the secret ID into the settings?

A setting is easy to copy and export. The secret ID comes in a response-wrapped token instead, which works once: the plugin unwraps it and keeps it sealed. Make the token with `bao write -wrap-ttl=10m -f auth/approle/role/<role>/secret-id`.

## Connect says "this token was already used or has expired: make a new one"

The wrapping token was unwrapped before, or its time ran out. Make a new one. If you did not use it yourself, someone else did: make a new secret ID and look into it.

## Test connection fails at Write

The AppRole's policy does not let it write under the base path. Check the policy in [Setup](index.md) against your KV mount and base path.

## Type a secret says no open terminal took the secret

The terminal closed or lost its connection, or the SSH Terminal plugin is not running. Open the terminal and try again.

## Which terminal does Type a secret type into?

From the toolbar or the panel beside a terminal: that terminal. From a key binding or the command palette: the terminal on screen for that host, and when there are several, the one you used last.

## Is the secret typed with Enter?

No. It is typed at the cursor, and you press Enter.

## Can I type a secret into a remote desktop?

No. Only SSH Terminal sessions.

## How long can a secret live?

As long as you keep it, unless it has an expiry time. Expiry times are at most 30 days ahead; an hourly sweep deletes expired ones.

## Do other plugins see my secrets?

A plugin that uses the service reads your secrets and the shared ones only while you act through it, as you, with your permissions. Its own area is separate from yours.
