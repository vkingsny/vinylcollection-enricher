{
  "result": {
    "id": "06d54f05-72a6-4aa8-afe8-ad9b789a4045",
    "number": 5,
    "metadata": {
      "created_on": "2025-10-16T16:02:58.360467Z",
      "source": "wrangler",
      "author_id": "66560a90d3c2824f38d4d358ccef3484",
      "author_email": "vinylkingsny@gmail.com",
      "has_preview": false
    },
    "annotations": {
      "workers/triggered_by": "secret"
    },
    "resources": {
      "script": {
        "etag": "2502a4738d1ff3d2752dd4b4d0f360e32a669557f7d64ed639b9d7e95c409358",
        "handlers": [
          "fetch"
        ],
        "last_deployed_from": "wrangler"
      },
      "script_runtime": {
        "assets": {
          "serve_directly": true
        },
        "compatibility_date": "2025-10-11",
        "compatibility_flags": [
          "global_fetch_strictly_public"
        ],
        "usage_model": "standard"
      },
      "bindings": [
        {
          "name": "DISCOGS_TOKEN",
          "type": "secret_text"
        }
      ]
    }
  },
  "success": true,
  "errors": [],
  "messages": []
}
