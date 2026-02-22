const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { execSync, execFileSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// yt-dlp binary – installed via curl in render.yaml buildCommand
const YTDLP_BIN = "/usr/local/bin/yt-dlp";
if (fs.existsSync(YTDLP_BIN)) {
  try {
    const ver = execFileSync(YTDLP_BIN, ["--version"], { encoding: "utf-8" }).trim();
    console.log("[startup] yt-dlp OK:", ver);
  } catch (e) {
    console.warn("[startup] yt-dlp exists but --version failed:", e.message);
  }
} else {
  console.error("[startup] yt-dlp NOT FOUND at", YTDLP_BIN, "– downloads will fail");
}

// Write YouTube cookies to disk at startup if provided via env
const COOKIES_FILE = "/tmp/yt-cookies.txt";
if (process.env.YT_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES, "utf-8");
  console.log("[startup] YouTube cookies written to", COOKIES_FILE);
} else {
  console.log("[startup] No YT_COOKIES set – downloads may fail due to bot detection");
}

// Safe yt-dlp wrapper – automatically injects cookies + android client args
function ytdlp(args, timeout = 120000) {
  const extraArgs = [
    "--extractor-args", "youtube:player_client=android_music,web",
  ];
  if (fs.existsSync(COOKIES_FILE)) {
    extraArgs.push("--cookies", COOKIES_FILE);
  }
  const fullArgs = [...extraArgs, ...args];
  try {
    const stdout = execFileSync(YTDLP_BIN, fullArgs, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}` },
    });
    return { stdout, stderr: "", ok: true };
  } catch (e) {
    return {
      stdout: (e.stdout || "").toString(),
      stderr: (e.stderr || e.message || "").toString(),
      ok: false,
    };
  }
}

// Spotify metadata via page scrape (no API key needed)
async function spotifyMeta(url) {
  const trackId = url.match(/\/track\/([a-zA-Z0-9]+)/)?.[1];
  const albumId = url.match(/\/album\/([a-zA-Z0-9]+)/)?.[1];
  const playlistId = url.match(/\/playlist\/([a-zA-Z0-9]+)/)?.[1];
  const id = trackId || albumId || playlistId;
  const type = trackId ? "track" : albumId ? "album" : "playlist";

  if (!id) throw new Error("Ungültige Spotify URL");

  // Spotify oEmbed gives us at least a title + thumbnail for single tracks
  const embedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const r = await fetch(embedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Spotify oEmbed fehlgeschlagen: ${r.status}`);
  const data = await r.json();

  // oEmbed title is the track name; use it directly as search query (no "Unknown" prefix)
  const title = data.title || "Unknown";
  return {
    type,
    tracks: [{
      title,
      artist: null,
      album: null,
      year: null,
      duration: 0,
      thumbnail: data.thumbnail_url || null,
      trackNumber: 1,
      directUrl: null,
      searchQuery: title,  // clean search query: just the song title
      isYoutube: false,
    }],
  };
}

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/version", (req, res) => {
  try {
    const version = execSync("yt-dlp --version", { encoding: "utf-8" }).trim();
    res.json({ ytdlp: version });
  } catch (e) {
    res.status(500).json({ error: "yt-dlp not found" });
  }
});

app.get("/debug", (req, res) => {
  const checks = {};
  // Binary exists?
  checks.ytdlp_bin_exists = fs.existsSync(YTDLP_BIN);
  // Version
  try {
    checks.ytdlp_version = execFileSync(YTDLP_BIN, ["--version"], { encoding: "utf-8", timeout: 10000 }).trim();
  } catch (e) {
    checks.ytdlp_version_error = e.message;
  }
  // ffprobe
  try {
    checks.ffprobe_version = execSync("ffprobe -version 2>&1 | head -1", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch (e) {
    checks.ffprobe_error = e.message;
  }
  // Cookies
  checks.cookies_file_exists = fs.existsSync(COOKIES_FILE);
  checks.yt_cookies_env_set = !!process.env.YT_COOKIES;
  // PATH
  checks.path = process.env.PATH;
  res.json(checks);
});

// ==============================================
// ENDPOINT: /resolve
// Accepts: { url: "youtube or spotify url" }
// Returns metadata without downloading
// ==============================================
app.post("/resolve", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const isSpotify = url.includes("open.spotify.com");
  const isYoutubePlaylist = (url.includes("youtube.com") || url.includes("youtu.be")) && url.includes("list=");
  const isSpotifyCollection = isSpotify && (url.includes("/album/") || url.includes("/playlist/"));
  const useFlat = isYoutubePlaylist || isSpotifyCollection;

  let type = "track";
  if (isSpotify && url.includes("/album/")) type = "album";
  else if (isSpotify && url.includes("/playlist/")) type = "playlist";
  else if (isYoutubePlaylist) type = "playlist";

  try {
    // Build yt-dlp args (no shell = no escaping issues)
    const args = ["--dump-json", "--no-download", "--no-warnings"];
    if (useFlat) args.push("--flat-playlist");
    args.push(url);

    const { stdout, stderr, ok } = ytdlp(args);

    // If yt-dlp failed or produced no output, try Spotify fallback
    if (!ok || !stdout.trim()) {
      if (isSpotify) {
        console.log(`[resolve] yt-dlp failed for Spotify, using oEmbed fallback. Error: ${stderr.substring(0, 150)}`);
        const fallback = await spotifyMeta(url);
        return res.json({ ...fallback, total: fallback.tracks.length });
      }
      throw new Error(stderr.substring(0, 300) || "yt-dlp produced no output");
    }

    const lines = stdout.trim().split("\n").filter(l => l.trim());

    const tracks = lines.map((line, i) => {
      try {
        const d = JSON.parse(line);
        const title = d.track || d.title || "Unknown";
        const artist = d.artist || d.creator || d.uploader || d.channel || "Unknown";
        const album = d.album || null;

        let resolvedTitle = title;
        let resolvedArtist = artist;
        // YouTube flat-playlist titles are often "Artist - Title"
        if (useFlat && !isSpotify && title.includes(" - ") && (artist === "Unknown" || !d.artist)) {
          const parts = title.split(" - ");
          resolvedArtist = parts[0].trim();
          resolvedTitle = parts.slice(1).join(" - ").trim();
        }

        return {
          title: resolvedTitle,
          artist: resolvedArtist,
          album: album || null,
          year: d.release_year || (d.upload_date ? parseInt(d.upload_date.substring(0, 4)) : null),
          duration: d.duration || 0,
          thumbnail: d.thumbnail || d.thumbnails?.[0]?.url || null,
          trackNumber: i + 1,
          directUrl: !isSpotify ? (d.url || d.webpage_url || null) : null,
          searchQuery: `${resolvedArtist} ${resolvedTitle}`.trim(),
          isYoutube: !isSpotify,
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    if (tracks.length === 0) {
      return res.status(404).json({ error: "Keine Tracks gefunden" });
    }

    // Propagate album name across collection tracks
    if (type !== "track") {
      const firstAlbum = tracks.find(t => t.album)?.album;
      if (firstAlbum) tracks.forEach(t => { if (!t.album) t.album = firstAlbum; });
    }

    res.json({ type, total: tracks.length, tracks });
  } catch (error) {
    console.error(`[resolve] Error for "${url}":`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==============================================
// ENDPOINT: /download
// Accepts: { query } OR { url } + optional { metadata }
// Downloads MP3, uploads to Supabase
// Returns: { success, audioUrl, duration, title, artist, album, year, thumbnail }
// ==============================================
app.post("/download", async (req, res) => {
  const { query, url: directUrl, metadata = {} } = req.body;

  if (!query && !directUrl) {
    return res.status(400).json({ error: "query or url is required" });
  }

  const label = metadata.title || query || directUrl;
  const safeLabel = (label || "track").replace(/[^a-zA-Z0-9_\- ]/g, "_").substring(0, 60).trim();
  const uid = uuidv4().substring(0, 8);
  const fileName = `${safeLabel.replace(/\s+/g, "_")}_${uid}.mp3`;
  const tmpDir = path.join(__dirname, "tmp");
  const filePath = path.join(tmpDir, fileName);

  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Build yt-dlp target: direct URL or YouTube search
  const target = directUrl || `ytsearch1:${query}`;

  try {
    // Download as MP3
    const ytdlpArgs = [
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "192K",
      "--no-playlist",
      "--max-downloads", "1",
      "--write-info-json",
      "--no-warnings",
      "-o", filePath,
      target,
    ];

    console.log(`[download] Starting: ${label}`);
    const { ok: dlOk, stderr: dlStderr } = ytdlp(ytdlpArgs, 300000);
    if (!dlOk) {
      // Check if file was still created despite non-zero exit (common with yt-dlp)
      const filesExist = fs.existsSync(filePath) || fs.existsSync(filePath + ".mp3") ||
        fs.readdirSync(tmpDir).some(f => f.includes(uid) && !f.endsWith(".json"));
      if (!filesExist) throw new Error(dlStderr.substring(0, 300) || "Download fehlgeschlagen");
    }

    // Find the downloaded file
    let actualPath = filePath;
    if (!fs.existsSync(actualPath) && fs.existsSync(filePath + ".mp3")) {
      actualPath = filePath + ".mp3";
    }
    if (!fs.existsSync(actualPath)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.includes(uid) && !f.endsWith(".json"));
      if (files.length > 0) actualPath = path.join(tmpDir, files[0]);
    }
    if (!fs.existsSync(actualPath)) {
      return res.status(500).json({ error: "Download fehlgeschlagen: Datei nicht gefunden" });
    }

    // Try to read yt-dlp metadata JSON
    let ytMeta = {};
    try {
      const jsonFiles = fs.readdirSync(tmpDir).filter(f => f.includes(uid) && f.endsWith(".info.json"));
      if (jsonFiles.length > 0) {
        ytMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFiles[0]), "utf-8"));
        fs.unlinkSync(path.join(tmpDir, jsonFiles[0]));
      }
    } catch (e) {}

    // Get duration
    let duration = 0;
    try {
      const durationStr = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${actualPath}"`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      duration = Math.floor(parseFloat(durationStr));
    } catch (e) {
      const stats = fs.statSync(actualPath);
      duration = Math.floor(stats.size / (192000 / 8));
    }

    // Upload to Supabase
    const fileBuffer = fs.readFileSync(actualPath);
    const { error: uploadError } = await supabase.storage
      .from("audio-files")
      .upload(fileName, fileBuffer, { contentType: "audio/mpeg" });

    if (uploadError) throw new Error("Supabase upload failed: " + uploadError.message);

    const { data: urlData } = supabase.storage.from("audio-files").getPublicUrl(fileName);

    fs.unlinkSync(actualPath);

    // Build final metadata: yt-dlp values override "Unknown"/null placeholders from metadata
    const ytArtist = ytMeta.artist || ytMeta.creator || ytMeta.uploader || null;
    const finalTitle = (metadata.title && metadata.title !== "Unknown") ? metadata.title : (ytMeta.track || ytMeta.title || safeLabel);
    const finalArtist = (metadata.artist && metadata.artist !== "Unknown") ? metadata.artist : (ytArtist || "Unknown");
    const finalAlbum = (metadata.album && metadata.album !== "Unknown") ? metadata.album : (ytMeta.album || null);
    const finalYear = metadata.year || ytMeta.release_year || (ytMeta.upload_date ? parseInt(ytMeta.upload_date.substring(0, 4)) : null);
    const finalThumbnail = metadata.thumbnail || ytMeta.thumbnail || null;

    console.log(`[download] Done: ${finalTitle} (${duration}s)`);

    res.json({
      success: true,
      audioUrl: urlData.publicUrl,
      duration,
      fileName,
      title: finalTitle,
      artist: finalArtist,
      album: finalAlbum,
      year: finalYear,
      thumbnail: finalThumbnail,
    });
  } catch (error) {
    try {
      fs.readdirSync(tmpDir).filter(f => f.includes(uid)).forEach(f => {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch (e) {}
      });
    } catch (e) {}
    console.error(`[download] Error for "${label}":`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Legacy /metadata endpoint (kept for backwards compat)
app.post("/metadata", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    const cmd = `yt-dlp --dump-json --no-download --flat-playlist "${url}" 2>/dev/null`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 60000 });
    const lines = output.trim().split("\n").filter(l => l.trim());
    const tracks = lines.map(line => {
      try {
        const data = JSON.parse(line);
        return {
          title: data.track || data.title || "Unknown",
          artist: data.artist || data.creator || data.uploader || "Unknown",
          album: data.album || "Unknown",
          duration: data.duration || 0,
          releaseYear: data.release_year || (data.upload_date ? parseInt(data.upload_date.substring(0, 4)) : null),
          spotifyUrl: data.url || data.webpage_url || url,
          thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || null
        };
      } catch (e) { return null; }
    }).filter(Boolean);
    if (tracks.length === 0) return res.status(404).json({ error: "No tracks found" });
    let type = "track";
    if (url.includes("/album/")) type = "album";
    if (url.includes("/playlist/")) type = "playlist";
    res.json({ type, tracks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker running on port ${PORT}`);
});
