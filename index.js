export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Existing asset-serving logic (using ASSETS_BUCKET)
    if (pathname !== '/generate-upload-url' && pathname !== '/confirm-upload') {
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

    // Endpoint to generate public R2 upload URL (using VIDEOS_BUCKET)
    if (pathname === '/generate-upload-url' && request.method === 'POST') {
      try {
        const { videoTitle, scheduleDateTime, videoType } = await request.json();
        if (!videoTitle || !scheduleDateTime || !videoType) {
          return new Response('Missing videoTitle, scheduleDateTime, or videoType', { status: 400 });
        }

        // R2 configuration
        const bucketName = env.R2_BUCKET_NAME; // "videos-gr8r"
        const accountId = "b703319f1a944be1b7fed06aca5656f8"; // Your account ID
        const objectKey = `videos/${Date.now()}-${videoTitle.replace(/\s+/g, '-')}.mp4`;
        const publicUrl = `https://pub-${accountId}.r2.dev/${bucketName}/${objectKey}`;

        return new Response(JSON.stringify({ uploadUrl: publicUrl, objectKey, publicUrl }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }

    // Endpoint to confirm upload and update Airtable
    if (pathname === '/confirm-upload' && request.method === 'POST') {
      try {
        const { objectKey, videoTitle, scheduleDateTime, videoType } = await request.json();
        if (!objectKey || !videoTitle || !scheduleDateTime || !videoType) {
          return new Response('Missing required fields', { status: 400 });
        }

        // Verify object exists in R2
        const bucketName = env.R2_BUCKET_NAME;
        const accountId = "b703319f1a944be1b7fed06aca5656f8";
        const publicUrl = `https://pub-${accountId}.r2.dev/${bucketName}/${objectKey}`;
        const r2Response = await fetch(publicUrl, { method: 'HEAD' });
        if (!r2Response.ok) {
          return new Response('Upload not found in R2', { status: 404 });
        }

        // Update Airtable
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
          message: `Uploaded ${videoTitle}, Airtable updated`,
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
  // Find record by Title
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
    // Create new record
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
            'R2 URL': r2Url // New field for R2 URL
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
    // Update existing record
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
          'R2 URL': r2Url // New field for R2 URL
        }
      })
    });
  }

  return { success: true, recordId };
}
