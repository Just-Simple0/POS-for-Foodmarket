# Tailwind Full Adoption (Adapter Mode)
Applied on: 2025-09-08T11:34:35.350441

## What changed
- Added tailwind.config.js (preflight disabled).
- Added css/tw-input.css with @apply adapters for existing classes.
- Inserted <link rel="stylesheet" href="css/tw.css"> into HTML heads.
- Created placeholder css/tw.css (build output).
- Updated/created package.json with scripts tw:build and tw:watch.

## Build
1) npm i -D tailwindcss
2) npm run tw:build

## Notes
- Keep linking order: css/common.css then css/tw.css.
- If you toggle utility classes from JS, they are safelisted in tailwind.config.js.
- Edit adapters in css/tw-input.css to refine tone for buttons, tabs, forms, tables, toast.
