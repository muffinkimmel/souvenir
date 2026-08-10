require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const {
  SHOPIFY_STORE,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  PORT = 3000,
} = process.env;

// Bump this each quarter — see https://shopify.dev/docs/api/usage/versioning
const API_VERSION = '2026-07';

if (!SHOPIFY_STORE || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error('Missing SHOPIFY_STORE, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in your .env file.');
  process.exit(1);
}

const app = express();
// Base64 PNGs are ~33% bigger than the raw file, so give this some room.
app.use(express.json({ limit: '15mb' }));

/**
 * Shopify no longer hands out a static Admin API token you copy once
 * (that flow was retired Jan 1 2026). Instead, this server exchanges its
 * Client ID + Client Secret for a short-lived access token itself, using
 * the client credentials grant. Tokens last 24h, so we cache and refresh
 * automatically — nothing for you to manage by hand.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */
let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get access token: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

/**
 * Verifies that a request actually came through Shopify's App Proxy for
 * your store, not from someone hitting this endpoint directly. Shopify
 * signs proxy requests using the app's own Client Secret — the same one
 * used to get an access token, no separate secret involved.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */
function verifyAppProxySignature(req) {
  const { signature, ...rest } = req.query;
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(',') : rest[key];
      return `${key}=${value}`;
    })
    .join('');

  const digest = crypto
    .createHmac('sha256', SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(signature)));
}

async function shopifyGraphQL(query, variables) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error('Shopify GraphQL error: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

async function uploadPngToShopifyFiles(buffer, filename) {
  // Step 1: ask Shopify for a place to upload the raw bytes to.
  const stagedData = await shopifyGraphQL(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource: 'FILE',
          filename,
          mimeType: 'image/png',
          httpMethod: 'POST',
          fileSize: String(buffer.length),
        },
      ],
    }
  );

  const stagedErrors = stagedData.stagedUploadsCreate.userErrors;
  if (stagedErrors.length) {
    throw new Error('stagedUploadsCreate error: ' + JSON.stringify(stagedErrors));
  }
  const target = stagedData.stagedUploadsCreate.stagedTargets[0];

  // Step 2: actually upload the bytes to the staged URL Shopify gave us.
  const form = new FormData();
  for (const { name, value } of target.parameters) {
    form.append(name, value);
  }
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename);

  const uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    throw new Error('Upload to staged URL failed: ' + uploadRes.status);
  }

  // Step 3: register that upload as a File in Shopify.
  const fileData = await shopifyGraphQL(
    `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message }
      }
    }`,
    {
      files: [
        {
          alt: filename,
          contentType: 'IMAGE',
          originalSource: target.resourceUrl,
        },
      ],
    }
  );

  const fileErrors = fileData.fileCreate.userErrors;
  if (fileErrors.length) {
    throw new Error('fileCreate error: ' + JSON.stringify(fileErrors));
  }
  const file = fileData.fileCreate.files[0];

  // Shopify processes the image asynchronously, so the public URL isn't
  // always ready immediately. Poll briefly until it is.
  return await pollForFileUrl(file.id);
}

async function pollForFileUrl(fileId, attempts = 10, delayMs = 600) {
  for (let i = 0; i < attempts; i++) {
    const data = await shopifyGraphQL(
      `query getFile($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            fileStatus
            image { url }
          }
        }
      }`,
      { id: fileId }
    );
    const node = data.node;
    if (node && node.fileStatus === 'READY' && node.image && node.image.url) {
      return node.image.url;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Timed out waiting for Shopify to finish processing the uploaded file.');
}

app.post('/design-upload', async (req, res) => {
  try {
    if (!verifyAppProxySignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { image } = req.body || {};
    if (!image || typeof image !== 'string' || !image.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ error: 'Expected { image: "data:image/png;base64,..." }' });
    }

    const base64 = image.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');

    // Reasonable sanity limit — a flattened 600x600 canvas PNG is a few
    // hundred KB at most. Adjust if you raise the canvas resolution.
    const MAX_BYTES = 8 * 1024 * 1024;
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: 'Image too large' });
    }

    const filename = `design-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const url = await uploadPngToShopifyFiles(buffer, filename);

    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed', detail: String(err.message || err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Design upload backend listening on port ${PORT}`);
});
