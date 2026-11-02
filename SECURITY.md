# Security policy

wp2payload reads content from WordPress sites that may be compromised and writes it into your
Payload database, so security reports are taken seriously.

## Reporting a vulnerability

Report privately through GitHub:
[Report a vulnerability](https://github.com/abdulrehmankz1/wp2payload/security/advisories/new).
Please do not open a public issue for a security problem.

Useful details: the wp2payload version, the command you ran, and the smallest input that shows
the problem (a post's HTML, a media file, a REST response). Use inert samples, such as an
`alert(1)` call, never working malware.

## What to expect

- An acknowledgement within 7 days.
- For high severity issues, a fix or a mitigation plan within 30 days.
- Credit in the release notes, unless you prefer not to be named.

## Supported versions

The latest minor release receives security fixes. While wp2payload is in 0.x, that is the latest
0.0.x release on npm.

## Scope

In scope: anything that lets content from a WordPress site get past the sanitizer or the media
checks into Payload, leaks the Application Password or other credentials, makes wp2payload
fetch or write somewhere it should not, or runs code at install time.

Out of scope: problems in WordPress, Payload or your own collections, and findings that need an
attacker who can already edit `wp2payload.config.ts` (the config file is code and runs as you).
