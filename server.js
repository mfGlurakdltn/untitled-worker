const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// CORS
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  res.header("Access-Control-Allow-Origin", allowed);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// yt-dlp version check
app.get("/version", (req, res) => {
  try {
    const version = execSync("yt-dlp --version", { encoding: "utf-8" }).trim();
    res.json({ ytdlp: version });
  } catch (e) {
    res.status(500).json({ error: "yt-dlp not found" });
  }
});

// ==============================================
// ENDPOINT 1: /download
// Accepts: { query: "Artist - Title" }
// Searches YouTube, downloads MP3, uploads to Supabase
// Returns: { success, audioUrl, duration, fileName }
// ==============================================
app.post("/download", async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: "query is required" });
  }

  const safeTitle = query.replace(/[^a-zA-Z0-9_\- ]/g, "_").substring(0, 60).trim();
  const uid = uuidv4().substring(0, 8);
  const fileName = `${safeTitle.replace(/\s+/g, "_")}_${uid}.mp3`;
  const tmpDir = path.join(__dirname, "tmp");
  const filePath = path.join(tmpDir, fileName);

  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Search YouTube for the query and download as MP3
    const ytdlpCmd = [
      "yt-dlp",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "192K",
      "--no-playlist",
      "--max-downloads", "1",
      "-o", filePath,
      `ytsearch1:${query}`
    ].join(" ");

    console.log(`[download] Starting: ${query}`);
    execSync(ytdlpCmd, { stdio: "pipe", timeout: 300000 });

    // yt-dlp might append .mp3 or not depending on version
    let actualPath = filePath;
    if (!fs.existsSync(actualPath) && fs.existsSync(filePath + ".mp3")) {
      actualPath = filePath + ".mp3";
    }
    // Also check without extension (yt-dlp sometimes strips it)
    if (!fs.existsSync(actualPath)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.includes(uid));
      if (files.length > 0) {
        actualPath = path.join(tmpDir, files[0]);
      }
    }

    if (!fs.existsSync(actualPath)) {
      return res.status(500).json({ error: "Download failed: file not created" });
    }

    // Get duration via ffprobe if available, otherwise estimate from file size
    let duration = 0;
    try {
      const durationStr = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${actualPath}"`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      duration = Math.floor(parseFloat(durationStr));
    } catch (e) {
      // Estimate: ~1 min per MB at 192kbps
      const stats = fs.statSync(actualPath);
      duration = Math.floor((stats.size / (192000 / 8)));
    }

    // Upload to Supabase Storage
    const fileBuffer = fs.readFileSync(actualPath);
    const { error: uploadError } = await supabase.storage
      .from("audio-files")
      .upload(fileName, fileBuffer, { contentType: "audio/mpeg" });

    if (uploadError) throw new Error("Supabase upload failed: " + uploadError.message);

    const { data: urlData } = supabase.storage
      .from("audio-files")
      .getPublicUrl(fileName);

    // Cleanup
    fs.unlinkSync(actualPath);

    console.log(`[download] Done: ${query} → ${fileName} (${duration}s)`);

    res.json({
      success: true,
      audioUrl: urlData.publicUrl,
      duration: duration,
      fileName: fileName
    });
  } catch (error) {
    // Cleanup on error
    try {
      const files = fs.readdirSync(tmpDir).filter(f => f.includes(uid));
      files.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
    } catch (e) {}
    console.error(`[download] Error for "${query}":`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==============================================
// ENDPOINT 2: /metadata
// Accepts: { url: "https://open.spotify.com/track/..." }
// Uses yt-dlp to extract metadata from Spotify URL
// Returns track info without downloading
// ==============================================
app.post("/metadata", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    // Use yt-dlp to dump JSON metadata from the Spotify URL
    const cmd = `yt-dlp --dump-json --no-download --flat-playlist "${url}" 2>/dev/null`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 60000 });

    // yt-dlp outputs one JSON object per line for playlists
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
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    if (tracks.length === 0) {
      return res.status(404).json({ error: "No tracks found for this URL" });
    }

    // Detect type based on URL
    let type = "track";
    if (url.includes("/album/")) type = "album";
    if (url.includes("/playlist/")) type = "playlist";

    res.json({ type, tracks });
  } catch (error) {
    console.error(`[metadata] Error for "${url}":`, error.message);

    // Fallback: try to parse the URL manually for basic info
    if (url.includes("open.spotify.com")) {
      res.status(500).json({
        error: "Could not extract metadata. yt-dlp may not support this Spotify URL directly.",
        hint: "Try providing track details manually or wait for Spotify API integration."
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker running on port ${PORT}`);
});
