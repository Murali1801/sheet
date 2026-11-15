# Contributing

Thanks for helping with Sheet, a zero-dependency `<bottom-sheet>` Web Component with spring physics. Issues, ideas and pull requests are all welcome.

## Getting started

You need Node 22.18 or newer.

```bash
git clone https://github.com/Murali1801/sheet.git
cd sheet
npm install
npm run dev
```

Before you open a pull request:

```bash
npm test
npm run build
```

Both run in CI on every pull request.

## Where things live

- `src/physics.ts` is pure: velocity projection, detent choice, rubber banding, the spring and dismiss rules. Tests live in `test/physics.test.ts`.
- `src/bottom-sheet.ts` is the custom element: pointer handling, `<dialog>`, slots, attributes and events.
- `index.html` and `site/` are the docs and demo site (built to `site-dist/`).

## Project rules

- The minified bundle must stay under 6 kB gzipped; `npm run build` fails above it.
- Animate with transforms only and keep `prefers-reduced-motion` working.
- Physics changes need a test, and a note in the PR on how it feels on a real phone.

## Good first issues

Issues labelled [good first issue](https://github.com/Murali1801/sheet/labels/good%20first%20issue) are small and self-contained. Comment on one before you start so two people don't pick the same thing.

## Pull requests

- One change per pull request, with a short description of what and why.
- Add or update tests when you change logic.
- Screenshots or a short screen recording help for anything visual.

## Code of conduct

Be kind and assume good intent. Harassment or personal attacks aren't tolerated.
