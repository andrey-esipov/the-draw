# Replit run notes

## Run the app

The Draw is a static Vite/React app. The configured `Dev` workflow runs:

```bash
npm run dev
```

The app listens on port `5210`, which is already configured for the Replit preview.
No database, backend service, or additional secrets are required.

For a production build:

```bash
npm run build
```

The app normally opens in the WebGL Board view. When WebGL is unavailable (such as
in a preview environment without a graphics context), it opens in the SVG Radial
view so the draw remains visible and interactive.