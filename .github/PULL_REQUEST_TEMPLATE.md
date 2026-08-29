<!--
  What this repository wants to read, and nothing else. Delete what does not
  apply; an empty section is better than a filled-in one that says nothing.
-->

## What changes, and why

<!-- The why is the part nobody can reconstruct later. -->

## Checks

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run contract`, and `protocol/contract.json` is committed if it moved

## Two questions this repository always asks

- **Does the wire contract change?** If so, Studio holds a byte-identical
  generated copy of it, and the change is not finished until that copy is
  regenerated. Say here which Studio change goes with this one.
- **Does this reverse something that was settled?** The list is at the end of
  [docs/contributing.md](../docs/contributing.md). Reversing one is allowed and
  is not a refactor: say what changed about the reasoning.
