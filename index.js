// v1.0.5 assets worker:
// - REPLACED direct Airtable logic with internal service binding (env.AIRTABLE_PROXY)
// - REPLACED Grafana logging with internal service binding (env.GRAFANA)
// - FIXED: replaced relative URLs in `new Request()` with absolute internal URLs (required for service binding compatibility)
// - PRESERVED: R2 video upload to VIDEOS_BUCKET
// - PRESERVED: asset serving from ASSETS_BUCKET
// - SUPPORTS: dynamic Airtable fields and structured Grafana log metadata

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Proxy video upload to R2
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

        const objectKey = `uploads/${Date.now()}-${title.replace(/\s+/g, '-')}.mov`;

        await env.VIDEOS_BUCKET.put(objectKey, file.stream(), {
          httpMetadata: { contentType: file.type || 'video/quicktime' },
        });

        const publicUrl = `https://videos.gr8r.com/${objectKey}`;

        // Send to Airtable Worker via internal service binding
        const airtableRequest = new Request('https://internal/api/airtable/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table: "Video posts",
            title,
            fields: {
              "Schedule Date-Time": scheduleDateTime,
              "Video Type": videoType,
              "R2 URL": publicUrl
            }
          })
        });

        const airtableResponse = await env.AIRTABLE_PROXY.fetch(airtableRequest);
        const airtableResult = await airtableResponse.json();

        // Log to Grafana using internal service binding
        const grafanaRequest = new Request('https://internal/api/grafana', {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level: airtableResponse.ok ? "info" : "error",
            message: airtableResponse.ok
              ? "R2 upload + Airtable update success"
              : `Airtable Worker failed: ${airtableResult?.error || "unknown error"}`,
            meta: {
              source: "assets-worker",
              service: "upload-video",
              videoTitle: title,
              r2Url: publicUrl,
              videoType,
              scheduleDateTime,
              airtableProxyStatus: airtableResponse.status
            }
          })
        });

        await env.GRAFANA.fetch(grafanaRequest);

        if (!airtableResponse.ok) {
          return new Response(`Airtable Worker failed: ${airtableResult?.error || "unknown error"}`, {
            status: 500
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Uploaded ${title} and updated Airtable`,
          videoTitle: title,
          scheduleDateTime,
          videoType,
          r2Url: publicUrl
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }

    // Serve public assets from ASSETS_BUCKET
    if (request.method === 'GET') {
      const key = decodeURIComponent(url.pathname.slice(1));
      const object = await env.ASSETS_BUCKET.get(key);

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
