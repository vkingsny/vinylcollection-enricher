/**
 * vinylcollection-enricher v4.2.3
 * One-call enrichment across Discogs, MusicBrainz, Wikidata, and Wikipedia.
 * Adds robust 400/429 handling and reintroduces dedupe() helper.
 */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const noCache = toBool(url.searchParams.get("nocache"));
    const cacheTTL = noCache ? 0 : 900;

    const flags = {
      all: toBool(url.searchParams.get("all")),
      images: (url.searchParams.get("images") || "both").toLowerCase(),
      lang: (url.searchParams.get("lang") || "en").toLowerCase(),
      max_images: clampInt(url.searchParams.get("max_images"), 1, 50, 12)
    };

    const cmd = url.searchParams.get("cmd");
    const seed = parseSeed(url, cmd);
    const out = initOut(flags);
    stamp(out, "start");

    try {
      normalizeSeed(seed, out);
      if (seed.upc || seed.barcode) await resolveDiscogsByUPC(seed, out);
      await resolveMusicBrainz(seed, out);
      await resolveWikidataAndWikipedia(seed, out);
      await enrichFromWikipedia(seed, out);
      if (flags.images !== "none") await buildImageGalleries(seed, out);
      finalizeCanonical(out);
      aggregateDownloadList(out);
      stamp(out, "done");
    } catch (e) {
      out.diagnostics.notes.push(`fatal:${String(e && e.message ? e.message : e)}`);
    }

    return json(out, cacheTTL);
  }
};

/* ------------------------------ Utilities ------------------------------ */

function initOut(flags) {
  return {
    schema_version: "4.2.3",
    timestamp: new Date().toISOString(),
    flags,
    canonical: { format: [], genre: [] },
    ids: {},
    wikipedia: {},
    wikidata: {},
    wiki: { article_gallery: [], album_gallery: [], artist_gallery: [] },
    downloads: { image_urls: [] },
    diagnostics: {
      matched_on: null,
      notes: [],
      tried_barcodes: [],
      mb_http: [],
      discogs_http: [],
      wiki_http: [],
      wd_http: []
    }
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
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
function json(obj, cacheTTL) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  headers["cache-control"] = cacheTTL > 0 ? `public, s-maxage=${cacheTTL}` : "no-store";
  return new Response(JSON.stringify(obj, null, 2), { status: 200, headers });
}
function normalizeBarcode(b) {
  if (!b) return null;
  const digits = (b + "").replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 12 || digits.length === 13) return digits;
  return digits.replace(/^0+/, "") || digits;
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
    artist: url.searchParams.get("artist")
  };

  if (cmd) {
    const parts = cmd.trim().split(/\s+/);
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
  if (seed.upc && seed.upc.length === 12) {
    const upc13 = ("0" + seed.upc).padStart(13, "0");
    out.diagnostics.tried_barcodes.push(upc13);
  }
}

/* ------------------------ HTTP helpers --------------------------- */
const UA = "vinylcollection-enricher/4.2.3 (contact: https://vinylcollection.vip; bot: true)";
const JSON_H = { accept: "application/json", "user-agent": UA };

async function GETjson(base, path, diagArr, qs = "") {
  const url = base + path + (qs ? (path.includes("?") ? "&" : "?") + qs : "");
  const r = await fetch(url, { headers: JSON_H });
  diagArr.push({ url: path + (qs ? "?" + qs : ""), status: r.status });
  if (r.status === 429) {
    await new Promise(res => setTimeout(res, 2000));
    const retry = await fetch(url, { headers: JSON_H });
    diagArr.push({ url: path + " (retry)", status: retry.status });
    if (!retry.ok) return null;
    return retry.json();
  }
  if (!r.ok) return null;
  return r.json();
}

/* ------------------------ Discogs --------------------------- */
async function resolveDiscogsByUPC(seed, out) {
  if (!seed.upc) return;
  const data = await GETjson(
    "https://api.discogs.com",
    "/database/search",
    out.diagnostics.discogs_http,
    new URLSearchParams({ type: "release", barcode: seed.upc, per_page: "1", page: "1" }).toString()
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
      url: `https://www.discogs.com/master/${hit.master_id}`
    };
  }

  if (hit.country) out.canonical.country = hit.country;
  if (hit.label && !out.canonical.label) out.canonical.label = hit.label;
  if (hit.genre && hit.genre.length) out.canonical.genre = dedupe(out.canonical.genre.concat(hit.genre));
  if (hit.style && hit.style.length) out.canonical.genre = dedupe(out.canonical.genre.concat(hit.style));
  if (hit.title && !out.canonical.title) {
    const m = hit.title.split(" – ");
    if (m.length === 2) {
      out.canonical.artist = out.canonical.artist || m[0];
      out.canonical.title = out.canonical.title || m[1];
    } else out.canonical.title = out.canonical.title || hit.title;
  }
  if (hit.year && !out.canonical.year) out.canonical.year = String(hit.year);
  if (hit.thumb && !out.canonical.cover_url) out.canonical.cover_url = hit.thumb;
  if (seed.upc) out.canonical.upc = seed.upc;
}

/* ------------------------ MusicBrainz --------------------------- */
async function resolveMusicBrainz(seed, out) {
  let mbRel = null;
  if (seed.upc) {
    const barcodes = dedupe(out.diagnostics.tried_barcodes.filter(Boolean));
    for (const bc of barcodes) {
      const q = new URLSearchParams({ query: `barcode:${bc}`, fmt: "json" }).toString();
      const search = await GETjson("https://musicbrainz.org/ws/2", "/release/", out.diagnostics.mb_http, q);
      if (search && search.releases && search.releases.length) {
        mbRel = search.releases[0];
        out.diagnostics.matched_on = "upc";
        break;
      }
    }
  }

  if (!mbRel && seed.mbid) mbRel = await hydrateMBRelease(seed.mbid, out);
  if (!mbRel && seed.mb_release_mbid) mbRel = await hydrateMBRelease(seed.mb_release_mbid, out);

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
  const full = await hydrateMBRelease(mbRel.id, out);
  if (!full) return;

  out.ids.mb_release_mbid = { id: full.id, url: `https://musicbrainz.org/release/${full.id}` };
  if (full["release-group"]) {
    const rg = full["release-group"];
    out.ids.mb_release_group = { id: rg.id, url: `https://musicbrainz.org/release-group/${rg.id}` };
  }
  if (full["artist-credit"] && full["artist-credit"].length) {
    const a = full["artist-credit"][0].artist;
    if (a && a.id) out.ids.mb_artist_id = { id: a.id, url: `https://musicbrainz.org/artist/${a.id}` };
  }

  if (!out.canonical.title) out.canonical.title = full.title || null;
  if (!out.canonical.artist && full["artist-credit"] && full["artist-credit"].length)
    out.canonical.artist = full["artist-credit"].map(ac => ac.name).join(" & ");
  if (full.country && !out.canonical.country) out.canonical.country = full.country;
  if (full.date && !out.canonical.year) out.canonical.year = String(full.date).slice(0, 4);
  if (full["label-info"] && full["label-info"].length) {
    const li = full["label-info"][0];
    if (li && li.label && li.label.name && !out.canonical.label) out.canonical.label = li.label.name;
    if (li && li.catalog_number && !out.canonical.catalog_number) out.canonical.catalog_number = li.catalog_number;
  }
  if (full.tags && full.tags.length) {
    const g = full.tags.map(t => titleCase(t.name));
    out.canonical.genre = dedupe(out.canonical.genre.concat(g));
  }
}

async function hydrateMBRelease(id, out) {
  const qs = new URLSearchParams({
    fmt: "json",
    inc: "url-rels+tags+artist-credits+label-info+release-group"
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

/* ------------------------ Helper --------------------------- */
function dedupe(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}
function titleCase(s) {
  return (s || "").replace(/\b\w/g, c => c.toUpperCase());
}
function finalizeCanonical(out) {
  if (!out.canonical.format || !out.canonical.format.length) {
    out.canonical.format = ["Album"];
  }
}
function aggregateDownloadList(out) {
  const urls = [];
  for (const g of [out.wiki.article_gallery, out.wiki.album_gallery, out.wiki.artist_gallery]) {
    for (const it of g) if (it?.url) urls.push(it.url);
  }
  out.downloads.image_urls = dedupe(urls);
}
