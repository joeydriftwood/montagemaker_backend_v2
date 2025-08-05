const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const jobs = new Map();

// Helper function to check if command exists
function commandExists(command) {
  return new Promise((resolve) => {
    exec(`which ${command}`, (error) => {
      resolve(!error);
    });
  });
}

// Helper function to get video duration using yt-dlp
async function getVideoDuration(url) {
  return new Promise((resolve, reject) => {
    exec(`yt-dlp --get-duration "${url}"`, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Helper function to download YouTube clip
async function downloadClip(url, startTime, duration, outputFile) {
  return new Promise((resolve, reject) => {
    const command = `yt-dlp -f "best[height<=720]" --external-downloader ffmpeg --external-downloader-args "ffmpeg_i:-ss ${startTime} -t ${duration}" -o "${outputFile}" "${url}"`;
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(outputFile);
    });
  });
}

// Helper function to create montage using FFmpeg
async function createMontage(clipList, outputFile, resolution, overlayText, fontSize) {
  return new Promise((resolve, reject) => {
    let ffmpegCmd = `ffmpeg -f concat -safe 0 -i "${clipList}"`;
    
    // Add text overlay if specified
    if (overlayText) {
      ffmpegCmd += ` -vf "scale=${resolution},drawtext=text='${overlayText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2"`;
    } else {
      ffmpegCmd += ` -vf "scale=${resolution}"`;
    }
    
    ffmpegCmd += ` -c:v libx264 -c:a aac -preset fast -crf 23 -y "${outputFile}"`;
    
    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(outputFile);
    });
  });
}

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(), 
    message: "Montage Maker Backend is running" 
  });
});

app.post("/api/generate-montage", async (req, res) => {
  try {
    const { 
      videoUrls, 
      interval, 
      montageLength, 
      resolution, 
      overlayText, 
      fontSize,
      customFilename 
    } = req.body;

    if (!videoUrls || videoUrls.length === 0) {
      return res.status(400).json({ error: "At least one video URL is required" });
    }

    const jobId = uuidv4();
    const job = { 
      id: jobId, 
      type: "montage", 
      status: "queued", 
      progress: 0, 
      createdAt: new Date(), 
      data: { videoUrls, interval, montageLength, resolution, overlayText, fontSize, customFilename } 
    };
    
    jobs.set(jobId, job);

    // Start processing in background
    processMontage(jobId, job.data);

    res.json({ jobId, status: "queued" });
  } catch (error) {
    console.error("Error in generate-montage:", error);
    res.status(500).json({ error: "Failed to start montage generation" });
  }
});

async function processMontage(jobId, data) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // Check dependencies
    const hasFFmpeg = await commandExists("ffmpeg");
    const hasYtDlp = await commandExists("yt-dlp");
    
    if (!hasFFmpeg || !hasYtDlp) {
      job.status = "failed";
      job.error = "Missing dependencies: FFmpeg and yt-dlp are required";
      jobs.set(jobId, job);
      return;
    }

    job.status = "processing";
    job.progress = 10;
    jobs.set(jobId, job);

    // Create workspace
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "montage-"));
    const scriptName = data.customFilename || "montage";
    const clipsNeeded = Math.floor(data.montageLength / data.interval);
    
    // Resolution mapping
    const resolutionMap = {
      '480p': '854x480',
      '720p': '1280x720',
      '1080p': '1920x1080'
    };
    const targetResolution = resolutionMap[data.resolution] || '1280x720';

    job.progress = 20;
    jobs.set(jobId, job);

    // Download clips
    const clips = [];
    for (let i = 0; i < clipsNeeded; i++) {
      const url = data.videoUrls[0]; // Use first video for now
      
      try {
        const duration = await getVideoDuration(url);
        const durationSeconds = parseDuration(duration);
        const maxStart = Math.max(0, durationSeconds - data.interval);
        const startTime = Math.floor(Math.random() * maxStart);
        
        const clipFile = path.join(workspace, `clip_${String(i + 1).padStart(2, '0')}.mp4`);
        await downloadClip(url, startTime, data.interval, clipFile);
        clips.push(clipFile);
        
        job.progress = 20 + (i / clipsNeeded) * 40;
        jobs.set(jobId, job);
      } catch (error) {
        console.error(`Failed to download clip ${i + 1}:`, error);
      }
    }

    job.progress = 60;
    jobs.set(jobId, job);

    // Create clip list for FFmpeg
    const clipList = path.join(workspace, "clip_list.txt");
    const clipListContent = clips.map(clip => `file '${clip}'`).join('\n');
    fs.writeFileSync(clipList, clipListContent);

    job.progress = 70;
    jobs.set(jobId, job);

    // Create montage
    const outputFile = path.join(workspace, `${scriptName}_v01.mp4`);
    await createMontage(clipList, outputFile, targetResolution, data.overlayText, data.fontSize || 48);

    job.progress = 90;
    jobs.set(jobId, job);

    // Create download URL (in a real implementation, you'd upload to cloud storage)
    const downloadUrl = `/api/download/${jobId}`;
    
    job.status = "completed";
    job.progress = 100;
    job.completedAt = new Date();
    job.downloadUrl = downloadUrl;
    job.outputFile = outputFile;
    jobs.set(jobId, job);

  } catch (error) {
    console.error("Error processing montage:", error);
    job.status = "failed";
    job.error = error.message;
    jobs.set(jobId, job);
  }
}

function parseDuration(duration) {
  const parts = duration.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parseInt(duration);
}

app.get("/api/job-status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

app.get("/api/download/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job || job.status !== "completed" || !job.outputFile) {
    return res.status(404).json({ error: "File not found" });
  }

  if (!fs.existsSync(job.outputFile)) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  res.download(job.outputFile, `${job.data.customFilename || 'montage'}_v01.mp4`);
});

app.get("/", (req, res) => {
  res.json({ 
    message: "Montage Maker Backend API", 
    version: "1.0.0",
    endpoints: [
      "POST /api/generate-montage",
      "GET /api/job-status/:jobId", 
      "GET /api/download/:jobId"
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
