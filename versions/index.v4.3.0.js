/**
 * vinylcollection-enricher v4.2.4
 * Single-call, identifier-first crosswalk across Discogs, MusicBrainz, Wikidata, and Wikipedia,
 * with image gallery + license credits. Supports “cmd” mini-grammar and classic query params.
 *
 * Inputs (any one identifier is enough):
 *   - upc / ean / barcode
 *   - mbid (release|release-group|artist) / mb_release_mbid / mb_release_group / mb_artist_id
 *   - discogs (release id) / discogs_release_id / discogs_master_id
 *   - qid (Wikidata Q-id)
 *   - artist + title (fallback)
 *   - cmd="enrich -all upc:888751119215" (mini-grammar)
 *
 * Flags:
 *   - all=1                : try all crosswalks and deep enrichment
 *   - images=(artist|album|both|none)  : default both
 *   - max_images=12        : default 12
 *   - lang=en              : default en
 *   - nocache=1            : disable CF cache for debugging
 *
 * Output schema (top-level keys):
 *   schema_version, timestamp, flags
 *   canonical: { title, artist, label, catalog_number, year, country, format[], genre[], cover_url, upc }
 *   ids: { discogs_release_id, discogs_master_id, mb_release_mbid, mb_release_group, mb_artist_id,
 *          wikidata_qid, artist_wikidata_qid, wikipedia_title }
 *   wikipedia: { title, summary, infobox, tracklist[], personnel[], producers[], engineers[],
 *                awards[], certifications[], landmarks[], notes[], sections{} }
 *   wikidata:  { entity: {}, sitelinks: {}, claims{} (selected), images_from_p18[] }
 *   wiki:      { article_gallery[], album_gallery[], artist_gallery[] }
 *   downloads: { image_urls[] }  // aggregated for aria2 batching later
 *   diagnostics: { matched_on, notes[], tried_barcodes[], mb_http[], discogs_http[], wiki_http[], wd_http[] }
 */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // CF caching policy
    const noCache = toBool(url.searchParams.get("nocache"));
    const cacheTTL = noCache ? 0 : 900; // 15 min

    // Flags
    const flags = {
      all: toBool(url.searchParams.get("all")),
      images: (url.searchParams.get("images") || "both").toLowerCase(), // artist|album|both|none
      lang: (url.searchParams.get("lang") || "en").toLowerCase(),
      max_images: clampInt(url.searchParams.get("max_images"), 1, 50, 12),
    };

    // Command grammar (optional)
    const cmd = url.searchParams.get("cmd");
    const seed = parseSeed(url, cmd);

    const out = initOut(flags);
    stamp(out, "start");

    try {
      // 1) Normalize primary keys
      normalizeSeed(seed, out);

      // 2) Resolve Discogs by UPC if available (cheap and often best cover art)
      if (seed.upc || seed.barcode) {
        await resolveDiscogsByUPC(seed, out);
      }

      // 3) Resolve MusicBrainz by barcode; then hydrate release, group, artist
      await resolveMusicBrainz(seed, out);

      // 4) Find Wikidata Q-ids from MB url-rels or fallback SPARQL,
      //    and enwiki sitelink for the album and the artist
      await resolveWikidataAndWikipedia(seed, out);

      // 5) Wikipedia enrichment
      await enrichFromWikipedia(seed, out);

      // 6) Images:
      //    - Article media-list (album page)
      //    - Artist P18 from Wikidata + fileinfo
      //    - Optional infobox lead image if exposed
      if (flags.images !== "none") {
        await buildImageGalleries(seed, out);
      }

      // 7) Canonical fields finalization (title/artist/genre/format/year/label/etc.)
      finalizeCanonical(out);

      // 8) Aggregate image URLs for aria2 batch
      aggregateDownloadList(out);

      stamp(out, "done");
    } catch (e) {
      out.diagnostics.notes.push(`fatal:${String(e && e.message ? e.message : e)}`);
    }

    // Response
    return json(out, cacheTTL);
  },
};

/* ------------------------------ Utilities ------------------------------ */

function initOut(flags) {
  return {
    schema_version: "4.3.0",
    timestamp: new Date().toISOString(),
    flags,
    canonical: {
      format: [],
      genre: [],
    },
    ids: {},
    wikipedia: {},
    wikidata: {},
    wiki: { article_gallery: [], album_gallery: [], artist_gallery: [] },
    downloads: { image_urls: [] },
    personnel: [],
    diagnostics: {
      matched_on: null,
      notes: [],
      tried_barcodes: [],
      mb_http: [],
      discogs_http: [],
      wiki_http: [],
      wd_http: [],
    },
  };
}

function stamp(out, name) {
  out[`ts_${name}`] = new Date().toISOString();
}

function toBool(v) {
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return dflt;
}

function json(obj, cacheTTL) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
  };
  if (cacheTTL > 0) {
    headers["cache-control"] = `public, s-maxage=${cacheTTL}`;
  } else {
    headers["cache-control"] = "no-store";
  }
  return new Response(JSON.stringify(obj, null, 2), { status: 200, headers });
}

function normalizeBarcode(b) {
  if (!b) return null;
  const digits = (b + "").replace(/\D+/g, "");
  if (!digits) return null;
  // Prefer 13-digit; also keep 12 for MB loose matching
  if (digits.length === 12) return digits;
  if (digits.length === 13) return digits;
  // Trim leading zeroes if longer
  return digits.replace(/^0+/, "") || digits;
}

function dedupe(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]+>/g, "");
}

function titleCase(s) {
  return (s || "").replace(/\b\w/g, c => c.toUpperCase());
}

/* ------------------------ Input seed parsing --------------------------- */

function parseSeed(url, cmd) {
  const seed = {
    upc: url.searchParams.get("upc") || url.searchParams.get("ean") || url.searchParams.get("barcode"),
    mbid: url.searchParams.get("mbid"),
    mb_release_mbid: url.searchParams.get("mb_release_mbid"),
    mb_release_group: url.searchParams.get("mb_release_group"),
    mb_artist_id: url.searchParams.get("mb_artist_id"),
    discogs: url.searchParams.get("discogs") || url.searchParams.get("discogs_release_id"),
    discogs_master_id: url.searchParams.get("discogs_master_id"),
    qid: url.searchParams.get("qid"),
    title: url.searchParams.get("title"),
    artist: url.searchParams.get("artist"),
  };

  if (cmd) {
    // grammar: enrich -all upc:888... | enrich -all artist:"Miles Davis" title:"Kind of Blue" | enrich -all qid:Q283221
    const lower = cmd.trim();
    const parts = lower.split(/\s+/);
    for (const p of parts) {
      const m = p.match(/^([a-z_]+):(.*)$/i);
      if (!m) continue;
      const k = m[1].toLowerCase();
      const v = m[2].replace(/^"(.+)"$/, "$1");
      if (k === "upc" || k === "ean" || k === "barcode") seed.upc = v;
      if (k === "mbid") seed.mbid = v;
      if (k === "discogs") seed.discogs = v;
      if (k === "qid") seed.qid = v;
      if (k === "artist") seed.artist = v;
      if (k === "title") seed.title = v;
    }
  }
  return seed;
}

function normalizeSeed(seed, out) {
  seed.upc = normalizeBarcode(seed.upc);
  if (seed.upc) out.diagnostics.tried_barcodes.push(seed.upc);
  // also test leading-0 13-digit if we have a 12-digit UPC
  if (seed.upc && seed.upc.length === 12) {
    const upc13 = ("0" + seed.upc).padStart(13, "0");
    out.diagnostics.tried_barcodes.push(upc13);
  }
}

/* ------------------------ HTTP helpers --------------------------- */

const UA =
  "vinylcollection-enricher/4.3.0 (contact: https://vinylcollection.vip; bot: true)";
const JSON_H = { accept: "application/json", "user-agent": UA };

async function GETjson(base, path, diagArr, qs = "") {
  const url = base + path + (qs ? (path.includes("?") ? "&" : "?") + qs : "");
  const r = await fetch(url, { headers: JSON_H });
  diagArr.push({ url: path + (qs ? "?" + qs : ""), status: r.status });
  if (r.status === 429) {
    // single backoff retry
    await new Promise(res => setTimeout(res, 2000));
    const retry = await fetch(url, { headers: JSON_H });
    diagArr.push({ url: path + " (retry)", status: retry.status });
    if (!retry.ok) return null;
    return retry.json();
  }
  if (r.ok) return r.json();
  return null;
}

/* ------------------------ Discogs --------------------------- */

async function resolveDiscogsByUPC(seed, out) {
  if (!seed.upc) return;
  // Database search is public without token; returns release + master ids (best-effort)
  const data = await GETjson(
    "https://api.discogs.com",
    "/database/search",
    out.diagnostics.discogs_http,
    new URLSearchParams({
      type: "release",
      barcode: seed.upc,
      per_page: "1",
      page: "1",
    }).toString()
  );
  if (!data) {
    out.diagnostics.notes.push("discogs query failed or rate-limited");
    return;
  }
  if (!data.results || !data.results.length) return;
  const hit = data.results[0];

  out.ids.discogs_release_id = hit.id
    ? { id: String(hit.id), url: `https://www.discogs.com/release/${hit.id}` }
    : undefined;

  if (hit.master_id) {
    out.ids.discogs_master_id = {
      id: String(hit.master_id),
      url: `https://www.discogs.com/master/${hit.master_id}`,
    };
  }

  // canonical hints
  if (hit.country) out.canonical.country = hit.country;
  if (hit.label && !out.canonical.label) out.canonical.label = hit.label;
  if (hit.genre && hit.genre.length) out.canonical.genre = dedupe(out.canonical.genre.concat(hit.genre));
  if (hit.style && hit.style.length) out.canonical.genre = dedupe(out.canonical.genre.concat(hit.style));
  if (hit.title && !out.canonical.title) {
    // Discogs title is often "Artist – Title"
    const m = hit.title.split(" – ");
    if (m.length === 2) {
      out.canonical.artist = out.canonical.artist || m[0];
      out.canonical.title = out.canonical.title || m[1];
    } else {
      out.canonical.title = out.canonical.title || hit.title;
    }
  }
  if (hit.year && !out.canonical.year) out.canonical.year = String(hit.year);
  if (hit.thumb && !out.canonical.cover_url) out.canonical.cover_url = hit.thumb;
  if (seed.upc) out.canonical.upc = seed.upc;
}

/* ------------------------ MusicBrainz --------------------------- */

async function resolveMusicBrainz(seed, out) {
  // 3a) if we have UPC, use search endpoint to find releases
  let mbRel = null;

  if (seed.upc) {
    // Two passes: 13-digit then 12 if applicable
    const barcodes = dedupe(out.diagnostics.tried_barcodes.filter(Boolean));
    for (const bc of barcodes) {
      const q = new URLSearchParams({ query: `barcode:${bc}`, fmt: "json" }).toString();
      const search = await GETjson("https://musicbrainz.org/ws/2", "/release/", out.diagnostics.mb_http, q);
      if (search && search.releases && search.releases.length) {
        // Pick the first high-score
        mbRel = search.releases[0];
        out.diagnostics.matched_on = "upc";
        break;
      }
    }
  }

  // 3b) or direct MBIDs provided
  if (!mbRel && seed.mbid) {
    mbRel = await hydrateMBRelease(seed.mbid, out);
  }
  if (!mbRel && seed.mb_release_mbid) {
    mbRel = await hydrateMBRelease(seed.mb_release_mbid, out);
  }

  // 3c) artist+title fallback
  if (!mbRel && (seed.artist || out.canonical.artist) && (seed.title || out.canonical.title)) {
    const artist = seed.artist || out.canonical.artist;
    const title = seed.title || out.canonical.title;
    const q = new URLSearchParams({ query: `${title} AND artist:${artist}`, fmt: "json" }).toString();
    const search = await GETjson("https://musicbrainz.org/ws/2", "/release/", out.diagnostics.mb_http, q);
    if (search && search.releases && search.releases.length) {
      mbRel = search.releases[0];
      out.diagnostics.matched_on = "artist+title";
    }
  }

  if (!mbRel) return;

  // hydrate detailed release data
  const full = await hydrateMBRelease(mbRel.id, out);
  if (!full) return;

  // set IDs
  out.ids.mb_release_mbid = {
    id: full.id,
    url: `https://musicbrainz.org/release/${full.id}`,
  };
  if (full["release-group"]) {
    const rg = full["release-group"];
    out.ids.mb_release_group = {
      id: rg.id,
      url: `https://musicbrainz.org/release-group/${rg.id}`,
    };
  }
  if (full["artist-credit"] && full["artist-credit"].length) {
    const a = full["artist-credit"][0].artist;
    if (a && a.id) {
      out.ids.mb_artist_id = { id: a.id, url: `https://musicbrainz.org/artist/${a.id}` };
    }
  }

  // canonical fields from MB
  if (!out.canonical.title) out.canonical.title = full.title || null;
  if (!out.canonical.artist && full["artist-credit"] && full["artist-credit"].length) {
    out.canonical.artist = full["artist-credit"].map(ac => ac.name).join(" & ");
  }
  if (full.country && !out.canonical.country) out.canonical.country = full.country;
  if (full.date && !out.canonical.year) out.canonical.year = String(full.date).slice(0, 4);
  if (full["label-info"] && full["label-info"].length) {
    const li = full["label-info"][0];
    if (li && li.label && li.label.name && !out.canonical.label) out.canonical.label = li.label.name;
    if (li && li.catalog_number && !out.canonical.catalog_number) out.canonical.catalog_number = li.catalog_number;
  }
  // tags -> genre
  if (full.tags && full.tags.length) {
    const g = full.tags.map(t => titleCase(t.name));
    out.canonical.genre = dedupe(out.canonical.genre.concat(g));
  }

  // url-rels -> try Discogs + Wikidata + enwiki links
  if (full.relations && full.relations.length) {
    for (const rel of full.relations) {
      if (!rel.url || !rel.url.resource) continue;
      const u = rel.url.resource;
      if (u.includes("discogs.com/release/") && !out.ids.discogs_release_id) {
        const id = u.split("/release/")[1]?.split(/[?#]/)[0];
        if (id) {
          out.ids.discogs_release_id = { id, url: `https://www.discogs.com/release/${id}` };
        }
      }
      if (u.includes("wikidata.org/wiki/Q")) {
        const qid = u.split("/wiki/")[1]?.split(/[?#]/)[0];
        if (qid && !out.ids.wikidata_qid) {
          out.ids.wikidata_qid = { id: qid, url: `https://www.wikidata.org/wiki/${qid}` };
        }
      }
      if (u.includes("en.wikipedia.org/wiki/") && !out.ids.wikipedia_title) {
        const title = decodeURIComponent(u.split("/wiki/")[1]);
        out.ids.wikipedia_title = { id: title, url: `https://en.wikipedia.org/wiki/${title}` };
      }
    }
  }

  // Also hydrate release-group + artist to improve cache hits (no parsing needed here)
  if (out.ids.mb_release_group?.id) {
    await GETjson(
      "https://musicbrainz.org/ws/2",
      `/release-group/${out.ids.mb_release_group.id}`,
      out.diagnostics.mb_http,
      "fmt=json"
    );
  }
  if (out.ids.mb_artist_id?.id) {
    await GETjson("https://musicbrainz.org/ws/2", `/artist/${out.ids.mb_artist_id.id}`, out.diagnostics.mb_http, "fmt=json");
  }
}

async function hydrateMBRelease(id, out) {
  const qs = new URLSearchParams({
    fmt: "json",
    inc: "url-rels+tags+artist-credits+label-info+release-group",
  }).toString();
  try {
    const r = await fetch(`https://musicbrainz.org/ws/2/release/${id}?${qs}`, { headers: JSON_H });
    out.diagnostics.mb_http.push({ url: `/release/${id}`, status: r.status });
    if (!r.ok) {
      out.diagnostics.notes.push(`musicbrainz release detail failed with status ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    out.diagnostics.notes.push(`musicbrainz release fetch error: ${String(e)}`);
    return null;
  }
}

/* ------------------------ Wikidata + Wikipedia --------------------------- */

async function resolveWikidataAndWikipedia(seed, out) {
  // If we already have album Q-id and artist Q-id, we’re done
  if (out.ids.wikidata_qid && out.ids.artist_wikidata_qid && out.ids.wikipedia_title) return;

  // If missing Q-id for album, try from MB relations we already scanned.
  // If still missing, try SPARQL by MB release-group id or by label+title.
  if (!out.ids.wikidata_qid) {
    // SPARQL by MB release-group if we have it
    if (out.ids.mb_release_group?.id) {
      const q = await sparqlFirstQIDForMBRG(out.ids.mb_release_group.id, out);
      if (q) {
        out.ids.wikidata_qid = { id: q, url: `https://www.wikidata.org/wiki/${q}` };
      }
    }
    // Fallback by title+artist
    if (!out.ids.wikidata_qid && out.canonical.title && out.canonical.artist) {
      const q = await sparqlFirstQIDByTitleArtist(out.canonical.title, out.canonical.artist, out);
      if (q) {
        out.ids.wikidata_qid = { id: q, url: `https://www.wikidata.org/wiki/${q}` };
      }
    }
  }

  // If artist Q-id missing: try from Wikidata claim on album (P175 performer) or MB artist relations
  if (!out.ids.artist_wikidata_qid) {
    // From MB artist relations
    if (out.ids.mb_artist_id?.id) {
      const qa = await sparqlFirstArtistQIDByMBArtist(out.ids.mb_artist_id.id, out);
      if (qa) {
        out.ids.artist_wikidata_qid = { id: qa, url: `https://www.wikidata.org/wiki/${qa}` };
      }
    }
    // From album Q-id claims P175
    if (!out.ids.artist_wikidata_qid && out.ids.wikidata_qid?.id) {
      const entity = await fetchWikidataEntity(out.ids.wikidata_qid.id, out);
      const performer = pickClaimId(entity, "P175");
      if (performer) {
        out.ids.artist_wikidata_qid = { id: performer, url: `https://www.wikidata.org/wiki/${performer}` };
      }
    }
  }

  // enwiki sitelink
  if (!out.ids.wikipedia_title) {
    if (out.ids.wikidata_qid?.id) {
      const entity = await fetchWikidataEntity(out.ids.wikidata_qid.id, out);
      const sitelinks = entity?.sitelinks || {};
      const enTitle = sitelinks?.enwiki?.title;
      if (enTitle) out.ids.wikipedia_title = { id: enTitle, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(enTitle)}` };
    }
  }
}

async function fetchWikidataEntity(qid, out) {
  const data = await GETjson("https://www.wikidata.org/wiki/Special:EntityData", `/${qid}.json`, out.diagnostics.wd_http, "");
  return data?.entities?.[qid] || null;
}

function pickClaimId(entity, prop) {
  const c = entity?.claims?.[prop];
  if (!c || !c.length) return null;
  for (const sn of c) {
    const v = sn?.mainsnak?.datavalue?.value;
    if (v && typeof v === "object" && v["id"]) return v["id"];
  }
  return null;
}

async function sparqlFirstQIDForMBRG(mbRGid, out) {
  const endpoint = "https://query.wikidata.org/sparql";
  const body = `
SELECT ?item WHERE {
  ?item wdt:P436 ?mbRG .
  FILTER(?mbRG = "${mbRGid}")
} LIMIT 1`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "accept": "application/sparql-results+json",
      "content-type": "application/sparql-query",
      "user-agent": UA,
    },
    body,
  });
  out.diagnostics.wd_http.push({ url: "SPARQL:MBRG->Q", status: r.status });
  if (!r.ok) return null;
  const json = await r.json();
  const b = json?.results?.bindings?.[0]?.item?.value;
  if (!b) return null;
  return b.split("/").pop();
}

async function sparqlFirstQIDByTitleArtist(title, artist, out) {
  const endpoint = "https://query.wikidata.org/sparql";
  const escTitle = title.replace(/"/g, '\\"');
  const escArtist = artist.replace(/"/g, '\\"');
  const body = `
SELECT ?item WHERE {
  ?item rdfs:label "${escTitle}"@en;
        wdt:P175 ?a.
  ?a rdfs:label "${escArtist}"@en.
} LIMIT 1`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "accept": "application/sparql-results+json",
      "content-type": "application/sparql-query",
      "user-agent": UA,
    },
    body,
  });
  out.diagnostics.wd_http.push({ url: "SPARQL:title+artist->Q", status: r.status });
  if (!r.ok) return null;
  const json = await r.json();
  const b = json?.results?.bindings?.[0]?.item?.value;
  if (!b) return null;
  return b.split("/").pop();
}

async function sparqlFirstArtistQIDByMBArtist(mbArtistId, out) {
  const endpoint = "https://query.wikidata.org/sparql";
  const body = `
SELECT ?item WHERE {
  ?item wdt:P434 "${mbArtistId}" .
} LIMIT 1`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "accept": "application/sparql-results+json",
      "content-type": "application/sparql-query",
      "user-agent": UA,
    },
    body,
  });
  out.diagnostics.wd_http.push({ url: "SPARQL:MBArtist->Q", status: r.status });
  if (!r.ok) return null;
  const json = await r.json();
  const b = json?.results?.bindings?.[0]?.item?.value;
  if (!b) return null;
  return b.split("/").pop();
}

/* ------------------------ Wikipedia enrichment --------------------------- */

async function enrichFromWikipedia(seed, out) {
  if (!out.ids.wikipedia_title?.id) return;

  const title = out.ids.wikipedia_title.id;

  // Summary
  const sum = await GETjson("https://en.wikipedia.org/api/rest_v1/page", `/summary/${encodeURIComponent(title)}`, out.diagnostics.wiki_http);
  if (sum?.title) {
    out.wikipedia.title = sum.title;
    out.wikipedia.summary = sum.extract || "";
    // lead image
    if (sum?.thumbnail?.source && !out.canonical.cover_url) out.canonical.cover_url = sum.thumbnail.source;
  }

  // Infobox (if exposed)
  const info = await GETjson("https://en.wikipedia.org/api/rest_v1/page", `/infobox/${encodeURIComponent(title)}`, out.diagnostics.wiki_http);
  if (info && typeof info === "object") out.wikipedia.infobox = info;

  // Media-list for gallery candidates
  const mediaList = await GETjson("https://en.wikipedia.org/api/rest_v1/page", `/media-list/${encodeURIComponent(title)}`, out.diagnostics.wiki_http);
  if (Array.isArray(mediaList?.items)) {
    for (const it of mediaList.items) {
      if (!it?.title || !it?.srcset) continue;
      const best = pickLargestSrc(it.srcset);
      if (best) {
        out.wiki.article_gallery.push({
          source: "enwiki:media-list",
          role: "gallery",
          title: it.title,
          url: best,
        });
      }
    }
  }

  // Sections via Parsoid HTML for track list, personnel, awards, landmarks, certifications
  const html = await fetch(`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`, { headers: JSON_H });
  out.diagnostics.wiki_http.push({ url: `/html/${title}`, status: html.status });
  if (html.ok) {
    const text = await html.text();
    extractTracklistFromHTML(text, out);
    extractPersonnelFromHTML(text, out);
    extractAwardsFromHTML(text, out);
    extractLandmarksFromHTML(text, out);
    extractCertificationsFromHTML(text, out);
  }
}

function pickLargestSrc(srcset) {
  // srcset: [{src, scale} or {src, width}] depending on endpoint. Choose the last.
  if (!Array.isArray(srcset) || !srcset.length) return null;
  const cand = srcset[srcset.length - 1];
  if (!cand?.src) return null;
  const u = cand.src.startsWith("//") ? "https:" + cand.src : cand.src;
  return u;
}

/* ------------------------ Image galleries --------------------------- */

async function buildImageGalleries(seed, out) {
  // Album article gallery is already in wiki.article_gallery

  // Artist P18 images
  if (out.ids.artist_wikidata_qid?.id) {
    const ent = await fetchWikidataEntity(out.ids.artist_wikidata_qid.id, out);
    const p18 = ent?.claims?.P18 || [];
    const files = [];
    for (const sn of p18) {
      const file = sn?.mainsnak?.datavalue?.value;
      if (file) files.push(file);
    }
    for (const f of files.slice(0, out.flags.max_images)) {
      const fi = await commonsImageInfo(f, out);
      if (fi?.url) {
        out.wiki.artist_gallery.push({
          source: "wikidata:P18",
          role: "image",
          title: `File:${f}`,
          url: fi.url,
          width: fi.width,
          height: fi.height,
          mime: fi.mime,
          credit: buildImageCredit(fi),
        });
      }
    }
  }
}

async function commonsImageInfo(filename, out) {
  // MediaWiki API
  const api = "https://commons.wikimedia.org/w/api.php";
  const qs = new URLSearchParams({
    action: "query",
    titles: `File:${filename}`,
    prop: "imageinfo",
    iiprop: "url|user|extmetadata|size|mime",
    format: "json",
    origin: "*",
  }).toString();
  const r = await fetch(`${api}?${qs}`, { headers: { "user-agent": UA } });
  out.diagnostics.wiki_http.push({ url: "/commons:imageinfo", status: r.status });
  if (!r.ok) return null;
  const j = await r.json();
  const pages = j?.query?.pages || {};
  const first = Object.values(pages)[0];
  const ii = first?.imageinfo?.[0];
  if (!ii) return null;
  const meta = ii.extmetadata || {};
  return {
    url: ii.url,
    width: ii.width,
    height: ii.height,
    mime: ii.mime,
    license: meta.LicenseShortName?.value || meta.License?.value || "",
    artist: meta.Artist?.value ? stripHtml(meta.Artist.value) : "",
    credit: meta.Credit?.value ? stripHtml(meta.Credit.value) : "",
    attributionRequired: meta.AttributionRequired?.value === "true",
    creditLine: meta.Credit?.value ? stripHtml(meta.Credit.value) : "",
    description: meta.ImageDescription?.value ? stripHtml(meta.ImageDescription.value) : "",
    title: first?.title || "",
  };
}

function buildImageCredit(fi) {
  const caption = fi.description || "";
  return {
    license: fi.license || "",
    artist: fi.artist || "",
    caption,
  };
}

function aggregateDownloadList(out) {
  const urls = [];
  for (const g of [out.wiki.article_gallery, out.wiki.album_gallery, out.wiki.artist_gallery]) {
    for (const it of g) {
      if (it?.url) urls.push(it.url);
    }
  }
  out.downloads.image_urls = dedupe(urls);
}

/* ------------------------ HTML content extraction --------------------------- */

function extractTracklistFromHTML(html, out) {
  // Simple parse: look for a table with track numbers and titles
  const rows = [];
  const tableMatch = html.match(/<table[^>]*class="wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/gi) || [];
  for (const tb of tableMatch) {
    if (!/Track listing|Track\s*list/i.test(tb) && !/Track\s*No\.?/i.test(tb)) continue;
    const tr = tb.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const r of tr) {
      const cols = Array.from(r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map(m => stripHtml(m[1]).trim());
      if (cols.length >= 2 && /^\d+/.test(cols[0])) {
        rows.push({ no: cols[0], title: cols[1] });
      }
    }
  }
  if (rows.length) out.wikipedia.tracklist = rows;
}

function extractPersonnelFromHTML(html, out) {
  // Scan for "Personnel" or "Credits" section lists
  const sec = html.match(/<h2[^>]*>[\s\S]*?<\/h2>[\s\S]*?(?=<h2|$)/gi) || [];
  const found = [];
  for (const s of sec) {
    if (!/Personnel|Credits/i.test(s)) continue;
    const lis = s.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    for (const li of lis) {
      const line = stripHtml(li).replace(/\s+/g, " ").trim();
      if (line) found.push(line);
    }
  }
  if (found.length) out.wikipedia.personnel = found;
}

function extractAwardsFromHTML(html, out) {
  const sec = html.match(/<h2[^>]*>[\s\S]*?<\/h2>[\s\S]*?(?=<h2|$)/gi) || [];
  const aw = [];
  for (const s of sec) {
    if (!/Awards|Accolades/i.test(s)) continue;
    const li = s.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    for (const l of li) {
      const t = stripHtml(l).trim();
      if (t) aw.push(t);
    }
  }
  if (aw.length) out.wikipedia.awards = aw;
}

function extractCertificationsFromHTML(html, out) {
  const sec = html.match(/<h2[^>]*>[\s\S]*?<\/h2>[\s\S]*?(?=<h2|$)/gi) || [];
  const cf = [];
  for (const s of sec) {
    if (!/Certifications/i.test(s)) continue;
    const li = s.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    for (const l of li) {
      const t = stripHtml(l).trim();
      if (t) cf.push(t);
    }
  }
  if (cf.length) out.wikipedia.certifications = cf;
}

function extractLandmarksFromHTML(html, out) {
  const hits = [];
  // very light heuristics
  const text = stripHtml(html).replace(/\s+/g, " ");
  [
    /Grammy Hall of Fame/i,
    /National Recording Registry/i,
    /RIAA\s+certified/i,
    /most influential/i,
    /landmark album/i,
  ].forEach(rx => {
    const m = text.match(rx);
    if (m) hits.push(m[0]);
  });
  if (hits.length) out.wikipedia.landmarks = dedupe(hits);
}

/* ------------------------ Canonical finalize --------------------------- */

function finalizeCanonical(out) {
  // format best-effort from MB + Discogs hints
  if (!out.canonical.format || !out.canonical.format.length) {
    const guess = [];
    guess.push("Album");
    out.canonical.format = dedupe(guess);
  }
}
