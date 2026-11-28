# sidecar

`node scripts/prepareSidecar.mjs` (run by `pnpm dev` and `pnpm bundle`) copies the
standalone `lurkloot` executable folder here. It ships as the app's `sidecar/`
resource. Everything here but this file is ignored by git.
