# Security Policy

## Supported versions

NarraLeaf Team is in early development. Fixes are made on the current release and
on the `develop` branch. Earlier versions are not maintained.

## Reporting a vulnerability

Report privately through GitHub's security advisory form:

**https://github.com/NarraLeaf/NarraLeaf-Team/security/advisories/new**

Do not open a public issue for a vulnerability, and do not describe one in a pull
request.

Include what a report needs to be acted on:

- The version of Team, and whether it is the container image or an installation
  from npm.
- What an attacker has to start with: an account on the server, network reach to
  a port, access to the storage root, or nothing at all.
- What they gain.
- The steps to reproduce it.

An acknowledgement is sent within seven days. A report that is confirmed is fixed
on `develop` and released, and the advisory is published once a release carrying
the fix is available.

## What is out of scope

The following are documented decisions rather than defects. A report about one of
them will be closed with a link to [docs/security.md](docs/security.md).

- **Every account on a server reaches every project on it.** There is no
  per-project access control.
- **Any account may take any project off the list.** The repository is not
  touched by it.
- **The four-digit live session code is not a secret.** Joining a session is
  bounded by holding an account on the server.
- **The rescue plane is guarded by access to the storage root.** Whoever holds
  that directory holds the signing keys.
- **The signing keys are fetched over plain HTTP on the loopback.** The reason,
  and the deployment that would have to revisit it, are in
  [docs/security.md](docs/security.md#accepted-risks).
- **Anything in the version-control server itself.** Report those to
  [EpicGames/lore](https://github.com/EpicGames/lore). The one that affects a
  Team deployment is recorded in
  [docs/security.md](docs/security.md#the-one-team-cannot-fix).

The accepted risks listed in [docs/security.md](docs/security.md#accepted-risks)
are known. A report that narrows one of them, or that shows the bound stated
there does not hold, is in scope.
