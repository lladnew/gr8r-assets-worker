export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Existing asset-serving logic (using ASSETS_BUCKET)
    if (pathname !== '/generate-upload-url' && pathname !== '/confirm-upload' && pathname !== '/upload-video') {
      const key = decodeURIComponent(pathname.slice(1)); // Remove leading slash
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
    }

    // Endpoint to generate upload metadata
    if (pathname === '/generate-upload-url' && request.method === 'POST') {
      try {
        const { videoTitle, scheduleDateTime, videoType } = await request.json();
        if (!videoTitle || !scheduleDateTime || !videoType) {
          return new Response('Missing videoTitle, scheduleDateTime, or videoType', { status: 400 });
        }

        const objectKey = `videos/${Date.now()}-${videoTitle.replace(/\s+/g, '-')}.mov`; // Changed to .mov
        const publicUrl = `https://assets.gr8r.com/videos/${objectKey}`; // Serve via Worker

        return new Response(JSON.stringify({ objectKey, publicUrl }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }

    // Endpoint to upload video via Worker
    if (pathname === '/upload-video' && request.method === 'POST') {
      try {
        const { videoTitle, scheduleDateTime, videoType } = await request.json();
        if (!videoTitle || !scheduleDateTime || !videoType) {
          return new Response('Missing videoTitle, scheduleDateTime, or videoType', { status: 400 });
        }

        const objectKey = `videos/${Date.now()}-${videoTitle.replace(/\s+/g, '-')}.mov`;
        const file = request.body;
        if (!file) {
          return new Response('No file provided', { status: 400 });
        }

        await env.VIDEOS_BUCKET.put(objectKey, file, {
          httpMetadata: { contentType: 'video/quicktime' },
        });

        // Update Airtable (simplified for upload)
        const airtableResult = await updateAirtable({
          videoTitle,
          scheduleDateTime,
          videoType,
          r2Url: `https://assets.gr8r.com/videos/${objectKey}`,
          airtableBaseId: env.AIRTABLE_BASE_ID,
          airtableTableId: env.AIRTABLE_TABLE_ID,
          airtableApiToken: env.AIRTABLE_API_TOKEN
        });

        if (!airtableResult.success) {
          return new Response(`Airtable update failed: ${airtableResult.error}`, { status: 500 });
        }

        return new Response(JSON.stringify({
          status: 'success',
          message: `Uploaded ${videoTitle} via Worker`,
          videoTitle,
          scheduleDateTime,
          videoType,
          r2Url: `https://assets.gr8r.com/videos/${objectKey}`
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }

    // Endpoint to confirm upload (for public URL flow, now optional)
    if (pathname === '/confirm-upload' && request.method === 'POST') {
      try {
        const { objectKey, videoTitle, scheduleDateTime, videoType } = await request.json();
        if (!objectKey || !videoTitle || !scheduleDateTime || !videoType) {
          return new Response('Missing required fields', { status: 400 });
        }

        const publicUrl = `https://assets.gr8r.com/videos/${objectKey}`;
        const airtableResult = await updateAirtable({
          videoTitle,
          scheduleDateTime,
          videoType,
          r2Url: publicUrl,
          airtableBaseId: env.AIRTABLE_BASE_ID,
          airtableTableId: env.AIRTABLE_TABLE_ID,
          airtableApiToken: env.AIRTABLE_API_TOKEN
        });

        if (!airtableResult.success) {
          return new Response(`Airtable update failed: ${airtableResult.error}`, { status: 500 });
        }

        return new Response(JSON.stringify({
          status: 'success',
          message: `Confirmed ${videoTitle}, Airtable updated`,
          videoTitle,
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

    return new Response('Method not allowed', { status: 405 });
  },
};

// Update Airtable with video metadata
async function updateAirtable({ videoTitle, scheduleDateTime, videoType, r2Url, airtableBaseId, airtableTableId, airtableApiToken }) {
  const response = await fetch(
    `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}?filterByFormula=${encodeURIComponent(`{Title} = "${videoTitle}"`)}`,
    {
      headers: {
        Authorization: `Bearer ${airtableApiToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  const { records } = await response.json();

  let recordId;
  if (records.length === 0) {
    const createResponse = await fetch(`https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${airtableApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        records: [{
          fields: {
            Title: videoTitle,
            'Schedule Date-Time': scheduleDateTime,
            'Video Type': videoType,
            'R2 URL': r2Url
          }
        }]
      })
    });
    const createResult = await createResponse.json();
    if (!createResponse.ok) {
      return { success: false, error: createResult.error?.message || 'Failed to create record' };
    }
    recordId = createResult.records[0].id;
  } else {
    recordId = records[0].id;
    await fetch(`https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}/${recordId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${airtableApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          'Schedule Date-Time': scheduleDateTime,
          'Video Type': videoType,
          'R2 URL': r2Url
        }
      })
    });
  }

  return { success: true, recordId };
}
