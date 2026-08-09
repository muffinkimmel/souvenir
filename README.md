# Design Upload Backend

This is the one custom-code piece from the integration plan: it receives the
flattened PNG your customizer produces, uploads it into your Shopify store's
Files (so it's hosted on Shopify's own CDN — no separate storage bill), and
returns a public URL. That URL is what gets attached to the cart as the
`_design_url` line item property (see `add-to-cart-with-design.js`), and
later what Flow puts in the order email.

## What it does, in order

1. Customer clicks "Save design" in the customizer → browser flattens the
   canvas to a PNG (already built, front-end only).
2. Front-end POSTs that PNG to `yourstore.com/apps/design-upload`.
3. Shopify's App Proxy quietly forwards that request to this server.
4. This server uploads the PNG into Shopify Files and hands back its URL.
5. Front-end adds the item to cart with that URL as a line item property.

## 1. Create a custom app in Shopify

1. Shopify admin → **Settings → Apps and sales channels → Develop apps**.
2. **Create an app** (e.g. name it "Design Upload").
3. **Configuration → Admin API integration** → enable the `write_files` and
   `read_files` scopes → Save.
4. **API credentials** tab → **Install app** → copy the **Admin API access
   token** (starts with `shpat_`). This only shows once — save it now.
   This becomes `SHOPIFY_ADMIN_TOKEN`.

## 2. Set up the App Proxy

Still in that same custom app:

1. Go to the app's **App proxy** settings (under Configuration).
2. **Subpath prefix:** `apps`
3. **Subpath:** `design-upload`
4. **Proxy URL:** the public URL where you deploy this server, e.g.
   `https://your-backend.onrender.com/design-upload`
5. Save. Shopify will show a **Shared secret** on this screen — that's
   `SHOPIFY_APP_PROXY_SECRET`.

Once this is saved, requests to `https://yourstore.com/apps/design-upload`
get forwarded to your server automatically, with a signature Shopify adds
so you can verify the request really came from your store.

## 3. Configure environment variables

Copy `.env.example` to `.env` and fill in the three values from steps 1–2:

```
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_...
SHOPIFY_APP_PROXY_SECRET=...
```

## 4. Run it locally to test

```
npm install
npm start
```

This starts the server on port 3000. You can sanity-check it's alive at
`http://localhost:3000/health`. To actually test uploads you'll need it
publicly reachable (see deployment below) since Shopify's App Proxy has to
be able to reach it — a tool like `ngrok` works for temporary testing
against your dev store before you deploy for real.

## 5. Deploy

Any Node host works — pick whichever you're already comfortable with:

- **Render** (render.com) — easiest for a small always-on Node service.
  New Web Service → connect this folder/repo → Build command `npm install`
  → Start command `npm start` → add the three env vars in the dashboard.
- **Railway** (railway.app) — similar one-click flow.
- **Fly.io** — good if you want more control, still simple for this size.

Whichever you pick, once it's live, update the **Proxy URL** in step 2 to
point at the deployed address (e.g. `https://your-app.onrender.com/design-upload`).

## 6. Point the customizer at it

Nothing to change here — `add-to-cart-with-design.js` already POSTs to
`/apps/design-upload` on your storefront domain, which is exactly what the
App Proxy intercepts. Once steps 1–5 are done, saving a design and adding
to cart will genuinely upload the design and attach its real URL.

## Notes / things to double check later

- **API version**: this uses Shopify Admin API `2026-07`. Shopify ships a
  new version every quarter — bump the `API_VERSION` constant in
  `server.js` periodically (shopify.dev/docs/api/usage/versioning).
- **File size limit**: currently caps uploads at 8MB, generous for a
  600x600 canvas PNG. Raise `MAX_BYTES` in `server.js` if you increase the
  customizer's canvas resolution later.
- **Signature verification** is skipped automatically if
  `SHOPIFY_APP_PROXY_SECRET` isn't set — handy for quick local testing, but
  make sure it's set in production so random requests can't hit your
  upload endpoint directly.
