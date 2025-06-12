export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // Proxy video upload to R2 via Worker
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

        // Update Airtable
        const airtableResult = await updateAirtable({
          videoTitle: title,
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

    return new Response("Not found", { status: 404 });
  },
};

// Airtable update function
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
