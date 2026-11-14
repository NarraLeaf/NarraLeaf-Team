# studio-kernel

`vendor/kernel.js` is generated from NarraLeaf Studio's `src/shared/authority/kernel.ts` and the
modules it imports, by `scripts/vendor-studio.mjs`. It is NarraLeaf Studio code and is licensed under
the **Mozilla Public License 2.0** (MPL-2.0), the licence of the Studio repository, not under the MIT
licence that covers the rest of this repository. `vendor/stamp.json` names the Studio commit it was
bundled from.

MPL-2.0 is a file-level licence: these files stay MPL-2.0 and their source must remain available
(the Studio repository is the source), while the rest of this repository keeps its own licence.
Whether shipping them inside the Team package this way is acceptable is a decision for the project's
maintainers and has not been made yet; see docs/collab-realtime-refactor.zh.md.

Do not edit `vendor/` by hand: change Studio and run `node scripts/vendor-studio.mjs`.
