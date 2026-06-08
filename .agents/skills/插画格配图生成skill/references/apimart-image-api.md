# APIMart Image API Notes

Source docs:

- https://docs.apimart.ai/en/api-reference/images/gemini-3-pro/generation
- https://docs.apimart.ai/en/api-reference/tasks/status
- https://docs.apimart.ai/llms.txt

## Submit image generation task

Endpoint:

```http
POST https://api.apimart.ai/v1/images/generations
Authorization: Bearer $APIMART_API_KEY
Content-Type: application/json
```

Body:

```json
{
  "model": "gemini-3-pro-image-preview",
  "prompt": "image prompt",
  "size": "16:9",
  "n": 1,
  "resolution": "2K"
}
```

Important fields:

- `model`: use `gemini-3-pro-image-preview` unless the user explicitly asks for the official channel.
- `prompt`: required text description.
- `size`: supported ratios include `auto`, `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`.
- `n`: integer 1-4. For this skill, always submit one image per section with `n=1`.
- `resolution`: `1K`, `2K`, or `4K`.
- `official_fallback`: optional boolean. Do not send it with the `gemini-3-pro-image-preview-official` model.
- `image_urls`: optional reference images, up to 14 items. Each item can be a public image URL or a full data URI.

Successful response shape:

```json
{
  "code": 200,
  "data": [
    {
      "status": "submitted",
      "task_id": "task_..."
    }
  ]
}
```

## Poll task status

Endpoint:

```http
GET https://api.apimart.ai/v1/tasks/{task_id}?language=zh
Authorization: Bearer $APIMART_API_KEY
```

Task statuses:

- `pending`
- `processing`
- `completed`
- `failed`
- `cancelled`

Successful completed response shape:

```json
{
  "code": 200,
  "data": {
    "id": "task_...",
    "status": "completed",
    "progress": 100,
    "result": {
      "images": [
        {
          "url": ["https://upload.apimart.ai/f/image/...png"],
          "expires_at": 1763174708
        }
      ]
    }
  }
}
```

Generated image URLs expire, commonly within 24 hours. Download images immediately and store the local paths in the final result.
