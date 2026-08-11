import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { verifySession } from "@house/server-lib";
import { readJsonBody } from "../_lib/http.js";

/**
 * Issues short-lived client upload tokens for restoring a backup archive
 * that lives outside this deployment (e.g. pulled back down from Proton
 * Drive after total data loss) — mirrors api/blob/upload.ts's photo-upload
 * pattern exactly, for the same reason: the browser uploads the zip
 * straight to Vercel Blob, sidestepping Vercel Functions' 4.5MB request
 * body limit, which a multi-year archive with photos can easily exceed.
 * Only the resulting URL then goes to POST /api/backup/restore.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    console.error("BLOB_READ_WRITE_TOKEN is not set; backup restore upload is unavailable");
    res.status(500).json({
      error: "Backup restore is not configured on this server (BLOB_READ_WRITE_TOKEN is not set).",
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
        let clientPayload: { authToken?: string } = {};
        try {
          clientPayload = clientPayloadRaw ? JSON.parse(clientPayloadRaw) : {};
        } catch {
          throw new Error("invalid client payload");
        }
        if (!clientPayload.authToken) {
          throw new Error("missing session token");
        }
        // Throws if invalid/expired — same auth gate as every other
        // endpoint, worked around the same way api/blob/upload.ts does
        // (the @vercel/blob/client upload() helper can't send custom
        // headers to handleUploadUrl, so the token rides in clientPayload).
        await verifySession(clientPayload.authToken);

        return {
          allowedContentTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
          maximumSizeInBytes: 200 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: null,
        };
      },
      onUploadCompleted: async () => {
        // No server-side action needed: the client calls
        // POST /api/backup/restore with the resulting URL itself once
        // upload() resolves — same pattern as photo attach. This webhook
        // also requires a publicly reachable deployment URL, so it won't
        // fire in local dev regardless.
      },
    });

    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error("backup restore-upload token request failed", err);
    res.status(400).json({ error: err instanceof Error ? err.message : "upload failed" });
  }
}
