// v1.0.8 assets-worker:
// - ADDED: triggers transcription job via gr8r-revai-worker after successful Airtable update
// - ADDED: Grafana logging for each major step:
//     • R2 upload
//     • Airtable update
//     • Rev.ai job submission
// - ENHANCED: verbose error logging with structured meta for troubleshooting
// - NOTE: service binding "REVAI" must be added to wrangler config

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, hostname } = url;

    if (pathname === '/upload-video' && request.method === 'POST') {
      try {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("multipart/form-data")) {
          return new Response("Expected multipart/form-data", { status: 400 });
        }

        const formData = await request.formData();
        const file = formData.get("video");
        const title = formData.get("title");
        const scheduleDateTime = formData.get("scheduleDateTime");
        const videoType = formData.get("videoType");

        if (!(file && title && scheduleDateTime && videoType)) {
          return new Response("Missing required fields", { status: 400 });
        }

        const sizeBytes = file.size;
        const sizeMB = (sizeBytes / 1048576).toFixed(2) + " MB";
        const mimeType = file.type || 'video/quicktime';
        const fileExt = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '.mov';
        const fullFilename = `${title}${fileExt}`;
        const objectKey = `uploads/${Date.now()}-${title.replace(/\s+/g, '-')}${fileExt}`;

        // Upload to R2
        await env.VIDEOS_BUCKET.put(objectKey, file.stream(), {
          httpMetadata: { contentType: mimeType }
        });

        const publicUrl = `https://videos.gr8r.com/${objectKey}`;

        // Log upload success
        await env.GRAFANA.fetch(new Request('https://internal/api/grafana', {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level: "info",
            message: "Video uploaded to R2 successfully",
            meta: {
              source: "assets-worker",
              service: "upload-video",
              videoTitle: title,
              r2Url: publicUrl,
              videoType,
              scheduleDateTime
            }
          })
        }));

        // Send to Airtable Worker
        const airtablePayload = {
          table: "Video posts",
          title,
          fields: {
            "Schedule Date-Time": scheduleDateTime,
            "Video Type": videoType,
            "R2 URL": publicUrl,
            "Video File Size": sizeMB,
            "Video File Size Number": sizeBytes,
            "Content Type": mimeType,
            "Video Filename": fullFilename
          }
        };

        const airtableRequest = new Request('https://internal/api/airtable/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(airtablePayload)
        });

        const airtableResponse = await env.AIRTABLE_PROXY.fetch(airtableRequest);
        const airtableResult = await airtableResponse.json();
        const airtableSuccess = airtableResponse.ok;

        await env.GRAFANA.fetch(new Request('https://internal/api/grafana', {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level: airtableSuccess ? "info" : "error",
            message: airtableSuccess
              ? "Airtable update successful"
              : `Airtable Worker failed: ${airtableResult?.error || "unknown error"}`,
            meta: {
              source: "assets-worker",
              service: "upload-video",
              videoTitle: title,
              r2Url: publicUrl,
              videoType,
              scheduleDateTime,
              airtableProxyStatus: airtableResponse.status,
              ...(airtableSuccess ? {} : { airtableResponse: airtableResult })
            }
          })
        }));

        if (!airtableSuccess) {
          return new Response(`Airtable Worker failed: ${airtableResult?.error || "unknown error"}`, {
            status: 500
          });
        }

        // Send to Rev.ai Worker
        const revaiPayload = {
          media_url: publicUrl,
          metadata: title,
          callback_url: "https://hooks.zapier.com/hooks/catch/18389329/2lk9o5u/"
        };

        const revaiRequest = new Request('https://internal/api/revai/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(revaiPayload)
        });

        const revaiResponse = await env.REVAI.fetch(revaiRequest);
        const revaiResultText = await revaiResponse.text();
        const revaiSuccess = revaiResponse.ok;

        await env.GRAFANA.fetch(new Request('https://internal/api/grafana', {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level: revaiSuccess ? "info" : "error",
            message: revaiSuccess
              ? "Rev.ai job submission successful"
              : `Rev.ai job failed: ${revaiResultText}`,
            meta: {
              source: "assets-worker",
              service: "upload-video",
              videoTitle: title,
              r2Url: publicUrl,
              callbackUrl: revaiPayload.callback_url,
              revaiStatus: revaiResponse.status,
              ...(revaiSuccess ? {} : { revaiResponse: revaiResultText })
            }
          })
        }));

        if (!revaiSuccess) {
          return new Response(`Rev.ai Worker failed: ${revaiResultText}`, {
            status: 502
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Uploaded ${title}, updated Airtable, and submitted Rev.ai job`,
          videoTitle: title,
          scheduleDateTime,
          videoType,
          r2Url: publicUrl
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (error) {
        await env.GRAFANA.fetch(new Request('https://internal/api/grafana', {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level: "error",
            message: "Unhandled upload error",
            meta: {
              source: "assets-worker",
              service: "upload-video",
              error: error.message,
              stack: error.stack
            }
          })
        }));

        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }

    // Serve public assets from correct bucket
    if (request.method === 'GET') {
      const key = decodeURIComponent(url.pathname.slice(1));
      const bucket = hostname === "videos.gr8r.com" ? env.VIDEOS_BUCKET : env.ASSETS_BUCKET;
      const object = await bucket.get(key);

      if (!object) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};

