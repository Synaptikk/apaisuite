# Icons

The toolbar action icon and the extension's `icons` field in `manifest.json` are rendered from `assets/logos/suite.svg` into PNGs at 16/32/48/128 px. MV3 requires PNG (SVG support is partial and Edge-version-dependent).

## Regenerating

After editing `assets/logos/suite.svg`, regenerate the PNGs:

```bash
# from unified-extension-suite/
node scripts/render-icons.mjs
```

This writes `suite-{16,32,48,128}.png` into this directory using `@resvg/resvg-js` (pure-WASM rasterizer, no native build step). The script is idempotent — re-running it just overwrites the PNGs with the latest render.

If `@resvg/resvg-js` isn't installed, the script will throw. Reinstall it once:

```bash
cd scripts && npm install --no-save @resvg/resvg-js
```

## Manifest wiring

The `manifest.json::action.default_icon` and `manifest.json::icons` blocks reference these files. If you rename the SVG output naming convention, both blocks need to be updated to match.

## Module-specific icons (still TODO)

Sidebar nav entries currently render a generic 4-square icon for every module via `app.js`. To give a module its own sidebar icon, place an SVG at `modules/<id>/icon.svg` and update `app.js::moduleNavItem` to read `manifest.icon`.
