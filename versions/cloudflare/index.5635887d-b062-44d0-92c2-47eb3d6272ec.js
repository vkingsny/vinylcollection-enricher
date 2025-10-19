{
  "result": {
    "id": "5635887d-b062-44d0-92c2-47eb3d6272ec",
    "number": 3,
    "metadata": {
      "created_on": "2025-10-16T15:31:26.169083Z",
      "source": "wrangler",
      "author_id": "66560a90d3c2824f38d4d358ccef3484",
      "author_email": "records@vinylcollection.vip",
      "has_preview": true
    },
    "annotations": {
      "workers/triggered_by": "version_upload"
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
          "serve_directly": true,
          "raw_run_worker_first": false
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
