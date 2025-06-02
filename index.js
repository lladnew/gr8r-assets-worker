export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // remove leading slash

    if (!key) {
      return new Response("Welcome to the asset server", { status: 200 });
    }

    const object = await env.ASSETS_BUCKET.get(key);

    if (object === null) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  },
};
