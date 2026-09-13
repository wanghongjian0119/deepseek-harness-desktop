# Agent Note: Desktop payload brand tweaks

Status: implemented

English | [中文](2026-09-12-desktop-payload-brand-tweaks.zh.md)

## Problem

A payload built from source presents itself as "DSH Local Build". The sidebar brand row takes its label from the `brand.localBuild` entry of `@deepseek-ai/dsh-client-locale`, and that row renders in one of two mutually exclusive ways: when `localBuildVersion()` yields a value — always the case for a source build — the name is squeezed into a 12px `localBuildTitle` rule with a 6px `buildVersion` chip stacked under it inside a fixed 24px box; only a release build, whose `localBuildVersion()` compiles to `undefined`, gets the full 17px `fallbackBrandName`. Every locally-built payload therefore shipped a visibly shrunken, mislabelled brand.

Neither the name nor the sizes have a configuration seam. The string is compiled into the locale bundle's dictionaries, and the sizing lives in per-build-hashed CSS-module rules inside the sidebar bundle (`cguSKG_`, `ViNb6q_`, … — the prefix changes every build). The desktop app is the product surface for this deployment, so its brand row has to read as the product, at release legibility.

## Decision

`applyBrandTweaks` in `apps/desktop/src/payload-builder.ts` rewrites two client bundles inside the assembled payload, after the deploy closure is materialized and before the boot smoke, so the smoke verifies what ships. It runs two independent rewrites, each best-effort on its own:

- **Name.** `retitleBrandName` rewrites the label of both the zh and en `brand.localBuild` entries to `DeepSeek Harness`. Only the value is replaced, matched as `("brand\.localBuild"\s*:\s*")[^"]*(")`, so the key, its quoting, and every neighbouring entry survive verbatim. Both dictionaries are retitled because the key is shared: `@deepseek-ai/dsh-client-ui-layout` reads it as well as the sidebar.
- **Type.** `resizeBrandRow` raises `localBuildTitle` from 12px/13px to 17px/18px — the size the release path uses — and grows the version chip to 10px of type on the DeepSeek brand blue (`--dsw-static-deepseek-450`) behind white type, replacing the neutral inverted fill. The chip's own box, `border-radius`, and `padding` grow with its type; the rows holding the title (`localBuildBrand`, `brandIdentity`, `brandName`) grow from 24px to 33px, because the 24px box held 13 + 1 + 10 exactly and `logoRow`'s `overflow:hidden` would otherwise clip the taller title.

Every pattern matches on the `_suffix` part of the class name, never the hash prefix, and each declaration pattern anchors on `(^|;)` so that `height:` cannot match inside `line-height:`. Declarations are rewritten in place rather than whole rules: upstream owns property order and may add more of them.

The chip is resized per upstream variant. A source build renders the 6px/10px `buildVersion` chip; a release build renders the 8px/16px `buildRevision` one. Both grow to 10px of type, but only the source chip's box grows with it — the release chip's 16px box already fits 10px, and shrinking it to 14px would be a regression. Row growth follows the same rule: only the stacked layout outgrows its box, because only there is the chip stacked under the title rather than set beside it.

Both rewrites are cosmetic and best-effort by design. If upstream restructures the markup or moves the copy, the patterns do not match, the payload is left exactly as built, and a log line records it. Failing an update over a font size would be a poor trade.

## Alternatives considered

- **Compose the row through the `sidebar.brand.name` slot.** The sidebar bundle ships `renderSlot("sidebar.brand.name", {}, { fallback })`, so a browser-side plugin can occupy it. That means authoring and shipping a client plugin into the deployment to change a cosmetic default, and the fallback it replaces is the very row this note is about; the payload patch is smaller and needs no new bundle. Occupying the slot is the better route for a deployment that wants more than the name and the chip.
- **Declare the label through the locale service.** The dictionaries ship inside the payload and are shared with the layout package; nothing exposes a deployment-level override for a single key.
- **Adopt the release branch by defining `localBuildVersion` as undefined.** This yields the full-size `fallbackBrandName`, but also drops the version chip the payload deliberately shows, and depends on an internal symbol rather than on markup.
- **Leave the brand as upstream ships it.** Rejected: the product surface would keep advertising itself as a local build.

## Consequences

The desktop payload now carries the product name at release size with a legible, branded version chip, and the tweak re-applies automatically on every update — no manual re-patching after an upstream change, which was the previous arrangement.

The costs: the patch reads and rewrites two vendor bundles by regular expression, so it is coupled to upstream class-name suffixes, the `brand.localBuild` key, and the chip's declaration list. Any of those moving degrades the tweak to a silent no-op — never a build failure — and the log line is the only signal. The tests cover the current markup for both chip variants, the hash-prefix independence, idempotence, and the no-op path; they cannot cover a future upstream restructure.

## Verification

- `apps/desktop/tests/payload-brand.spec.ts` covers both dictionaries, both chip variants, hash-prefix independence, idempotence, the `fallbackBrandName` non-match, and the absent-bundle and no-match no-op paths.
- The spec's fixtures are upstream's own output, read from a payload assembled before this rewrite existed. A patched payload shows this patch's result and cannot pin the input it starts from.
- Reproduce on a real payload: run `applyBrandTweaks` against an assembled payload root and inspect `runtime/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js` and `…/dsh-client-ui-sidebar/lib/client.js`. To confirm what a running backend serves rather than what is on disk, request the GUI manifest's `/plugins/??…&rev=` bundle and read the rules out of that.
