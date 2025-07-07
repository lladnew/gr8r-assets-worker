// v1.1.0 assets-worker:
// - REMOVED: all upload and PUT logic (now handled by dedicated workers)
// - RETAINED: GET handler for serving assets from R2 (videos + general assets)
// - REMOVED: Grafana logs to reduce noise from asset serving

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, hostname } = url;

    if (request.method === 'GET') {
      const key = decodeURIComponent(pathname.slice(1));
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
