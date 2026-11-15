# Changelog

## 0.1.0 (2026-11-15)

First release.

- `<bottom-sheet>` custom element with `snap`, `open`, `initial`, `stiffness`, `damping`, `mass`, `dismissible`, `modal`, `backdrop-from` and `label` attributes.
- `show()`, `close()`, `snapTo()`; `open`, `index` and `detents` properties.
- `sheet-open`, `sheet-snap`, `sheet-drag` and `sheet-close` events.
- Velocity projection, rubber banding, a semi-implicit spring seeded by release velocity, velocity and distance dismiss.
- Nested scroll handoff, sticky header and footer slots, on-screen keyboard handling via `visualViewport`.
- Native `<dialog>` for modal sheets; reduced motion makes snaps instant.
- Pure physics module with Vitest tests.
- Docs site with a live stage, physics readout and tune-and-copy panel.
- 4.05 kB gzipped (minified bundle).
