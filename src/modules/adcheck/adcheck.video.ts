import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutsFromShowinfo } from "@/modules/adcheck/adcheck.shape";

/**
 * ffmpeg in the worker (installed in the runtime image). Normalising first means Gemini and the
 * scene detector always get the same thing: H.264 + AAC, at most 720p, ~2 Mbps, so a 60 s ad is
 * about 15 MB and goes to Gemini inline. Some uploads are AV1, which OpenCV and some browsers can't read.
 */

/** Scene-change threshold for ffmpeg's `scene` score (0–1). 0.3 matched the lab's cuts best. */
const SCENE = 0.3;

function run(cmd: string, args: string[], timeoutMs = 180_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export type Probe = { durationMs: number; width: number; height: number; hasAudio: boolean };

async function probe(file: string): Promise<Probe | null> {
  const { code, stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], 30_000);
  if (code !== 0) return null;
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
  const video = info.streams?.find((s) => s.codec_type === "video");
  const durationMs = Math.round(Number(info.format?.duration ?? 0) * 1000);
  if (!video || !durationMs) return null;
  return { durationMs, width: video.width ?? 0, height: video.height ?? 0, hasAudio: Boolean(info.streams?.some((s) => s.codec_type === "audio")) };
}

/** Below this peak loudness the sound track is silence: the audio pass is skipped, not guessed at. */
const SILENT_DB = -50;

/** Peak loudness of a file's sound in dB (≈ -91 for digital silence), or null when it can't be measured. */
async function peakDb(file: string): Promise<number | null> {
  const { code, stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], 60_000);
  const m = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  return code === 0 && m ? Number(m[1]) : null;
}

export type Prepared = Probe & { video: Buffer; cutsMs: number[] };

/**
 * Normalise an upload and find its cuts. Null when the file isn't a readable video.
 * `maxMs` is checked on the original before any encoding work.
 */
export async function prepare(upload: Buffer, maxMs: number): Promise<Prepared | "too_long" | null> {
  const dir = await mkdtemp(join(tmpdir(), "adcheck-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "out.mp4");
    await writeFile(input, upload);
    const original = await probe(input);
    if (!original) return null;
    if (original.durationMs > maxMs + 500) return "too_long";

    const encode = await run("ffmpeg", [
      "-v", "error", "-y", "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',fps=fps='min(source_fps,30)'",
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-maxrate", "2.5M", "-bufsize", "4M", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart", output,
    ]);
    if (encode.code !== 0) return null;
    const normalised = await probe(output);
    if (!normalised) return null;
    // A track of silence still counts as "audio" to ffprobe; Gemini then invents a voice-over and
    // music (seen 26 Oct on a silent draft). Only audible sound is sent to the audio pass.
    if (normalised.hasAudio) {
      const peak = await peakDb(output);
      if (peak !== null && peak < SILENT_DB) normalised.hasAudio = false;
    }

    const scenes = await run("ffmpeg", ["-v", "info", "-i", output, "-an", "-vf", `select='gt(scene,${SCENE})',showinfo`, "-f", "null", "-"]);
    return { ...normalised, video: await readFile(output), cutsMs: scenes.code === 0 ? cutsFromShowinfo(scenes.stderr) : [] };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
