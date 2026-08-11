import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { verifySession } from "@house/server-lib";
import { readJsonBody } from "../_lib/http.js";

/**
 * Issues short-lived client upload tokens for the direct-to-Vercel-Blob
 * flow described in docs/sync-design.md "Photo attach": the browser
 * uploads the photo bytes straight to Blob storage (sidestepping
 * Vercel Functions' 4.5MB body limit), and only the resulting URL comes
 * back through the API, via the separate `/api/readings/:id/photo`
 * endpoint — never through this route.
 *
 * Auth note: the `@vercel/blob/client` `upload()` helper's request to
 * this route's `handleUploadUrl` has no option to carry custom headers,
 * so it can't be gated with the usual `requireSession` (Authorization
 * header) pattern used by every other endpoint in api/. Instead the
 * client embeds its session token in `clientPayload` (see
 * apps/web/src/data/photos.ts), and `onBeforeGenerateToken` below
 * verifies it directly with `verifySession` before minting an upload
 * token. This is a deliberate deviation from the requireSession
 * convention forced by the SDK, not an oversight — flagged in the report
 * for a second look.
 */
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
    console.error("BLOB_READ_WRITE_TOKEN is not set; photo upload is unavailable");
    res.status(500).json({
      error: "Photo upload is not configured on this server (BLOB_READ_WRITE_TOKEN is not set).",
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
        let clientPayload: { authToken?: string; readingId?: string } = {};
        try {
          clientPayload = clientPayloadRaw ? JSON.parse(clientPayloadRaw) : {};
        } catch {
          throw new Error("invalid client payload");
        }
        if (!clientPayload.authToken) {
          throw new Error("missing session token");
        }
        // Throws if the token is missing/invalid/expired — handleUpload
        // propagates that as a rejected token request below.
        await verifySession(clientPayload.authToken);

        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: clientPayload.readingId ?? null,
        };
      },
      onUploadCompleted: async () => {
        // No server-side action needed: the client attaches the photo
        // URL itself via the dedicated /api/readings/:id/photo path
        // once `upload()` resolves (see apps/web/src/data/photos.ts).
        // This callback is a webhook Vercel calls back on `callbackUrl`,
        // which requires a publicly reachable deployment URL — it won't
        // fire in local dev, so nothing here should be load-bearing.
      },
    });

    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error("blob upload token request failed", err);
    res.status(400).json({ error: err instanceof Error ? err.message : "upload failed" });
  }
}
