import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { verifySession } from "@house/server-lib";
import { readJsonBody, getSessionCookie } from "../_lib/http.js";

/**
 * Issues short-lived client upload tokens for two direct-to-Vercel-Blob
 * flows, distinguished by `clientPayload.purpose`:
 *
 *  - "photo" (default, for backward compatibility with existing clients
 *    that don't send `purpose`): the reading-photo flow described in
 *    docs/sync-design.md "Photo attach" — the browser uploads the photo
 *    bytes straight to Blob storage, and only the resulting URL comes
 *    back through the API, via the separate `/api/readings/:id/photo`
 *    endpoint, never through this route.
 *  - "backup-restore": uploading a backup archive that lives outside this
 *    deployment (e.g. pulled back down from Proton Drive after total data
 *    loss) — only the resulting URL then goes to
 *    `POST /api/backup?action=restore`.
 *
 * Originally two separate files (this one and api/backup/upload.ts).
 * Merged for the same reason as api/backup.ts, api/cron.ts, api/sync.ts:
 * Vercel's Hobby plan caps a deployment at 12 Serverless Functions. Both
 * flows sidestep Vercel Functions' 4.5MB request body limit the same way,
 * so sharing the token-minting endpoint (with different
 * allowedContentTypes/size caps per purpose) is a natural merge, not a
 * forced one.
 *
 * Auth note: the `@vercel/blob/client` `upload()` helper's request to
 * this route's `handleUploadUrl` has no option to carry custom headers,
 * but it's a same-origin fetch, so the browser attaches the session
 * cookie the same as any other request — `onBeforeGenerateToken` below
 * reads it straight off `req` and verifies it with `verifySession` before
 * minting an upload token, for both purposes alike.
 */
const PURPOSE_CONFIG = {
  photo: {
    allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    maximumSizeInBytes: 25 * 1024 * 1024,
  },
  "backup-restore": {
    allowedContentTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    maximumSizeInBytes: 200 * 1024 * 1024,
  },
} as const;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // BLOB_READ_WRITE_TOKEN won't be set in this dev environment — fail
  // loudly and immediately rather than letting handleUpload blow up with
  // an opaque error deeper in the call stack.
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    console.error("BLOB_READ_WRITE_TOKEN is not set; blob upload is unavailable");
    res.status(500).json({
      error: "Uploads are not configured on this server (BLOB_READ_WRITE_TOKEN is not set).",
    });
    return;
  }

  const body = readJsonBody<HandleUploadBody>(req);

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: blobToken,
      onBeforeGenerateToken: async (_pathname, clientPayloadRaw) => {
        const sessionToken = getSessionCookie(req);
        if (!sessionToken) {
          throw new Error("missing session cookie");
        }
        // Throws if the token is missing/invalid/expired — handleUpload
        // propagates that as a rejected token request below.
        await verifySession(sessionToken);

        let clientPayload: { readingId?: string; purpose?: string };
        try {
          clientPayload = clientPayloadRaw ? JSON.parse(clientPayloadRaw) : {};
        } catch {
          throw new Error("invalid client payload");
        }

        const purpose = clientPayload.purpose === "backup-restore" ? "backup-restore" : "photo";
        const config = PURPOSE_CONFIG[purpose];

        return {
          allowedContentTypes: [...config.allowedContentTypes],
          maximumSizeInBytes: config.maximumSizeInBytes,
          addRandomSuffix: true,
          tokenPayload: purpose === "photo" ? (clientPayload.readingId ?? null) : null,
        };
      },
      onUploadCompleted: async () => {
        // No server-side action needed for either purpose: the client
        // attaches the result itself (photo attach, or backup restore)
        // once `upload()` resolves. This callback is a webhook Vercel
        // calls back on `callbackUrl`, which requires a publicly
        // reachable deployment URL — it won't fire in local dev, so
        // nothing here should be load-bearing.
      },
    });

    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error("blob upload token request failed", err);
    res.status(400).json({ error: err instanceof Error ? err.message : "upload failed" });
  }
}
