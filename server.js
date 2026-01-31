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

// CORS — bereinigt den Origin-Wert vor dem Setzen
const origin = (process.env.ALLOWED_ORIGIN || "*").trim().replace(/[\r\n]/g, "");
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (req, res) => res.sendStatus(200));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/download", async (req, res) => {
  const { videoId, title } = req.body;

  if (!videoId || !title) {
    return res.status(400).json({ error: "videoId and title are required" });
  }

  const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60);
  const fileName = safeTitle + "_" + uuidv4().substring(0, 8) + ".mp3";
  const filePath = path.join(__dirname, "tmp", fileName);

  if (!fs.existsSync(path.join(__dirname, "tmp"))) {
    fs.mkdirSync(path.join(__dirname, "tmp"));
  }

  try {
    const ytdlpCommand = "yt-dlp -x --audio-format mp3 --audio-quality 192K -o \"" + filePath + "\" \"https://www.youtube.com/watch?v=" + videoId + "\"";

    execSync(ytdlpCommand, {
      stdio: "pipe",
      timeout: 300000
    });

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "Download failed: file not created" });
    }

    const fileBuffer = fs.readFileSync(filePath);
    const { error: uploadError } = await supabase.storage
      .from("audio-files")
      .upload(fileName, fileBuffer, {
        contentType: "audio/mpeg"
      });

    if (uploadError) {
      throw new Error("Supabase upload failed: " + uploadError.message);
    }

    const { data: urlData } = supabase.storage
      .from("audio-files")
      .getPublicUrl(fileName);

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      audioUrl: urlData.publicUrl,
      fileName: fileName
    });

  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    console.error("Download error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Worker running on port " + PORT);
});
