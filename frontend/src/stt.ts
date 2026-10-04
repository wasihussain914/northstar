/** Speech-to-text that doesn't trust iPad Safari.
 *
 * Apple's SpeechRecognition can hang the whole page (especially in a
 * home-screen web app), so when the server advertises `stt` in /api/health,
 * the mics record audio with MediaRecorder — solid everywhere — and the
 * server transcribes it (local Whisper). Web Speech stays as the fallback
 * for servers without a transcriber.
 */

let available = false;

/** Tell the mics the server can transcribe (from /api/health). */
export function setServerStt(on: boolean) {
  available = on;
}

export function serverStt(): boolean {
  return available && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== "undefined";
}

function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** One tap-to-talk session: start() to record, stop() to get the transcript.
 * Hands-free: once speech is heard, ~1.6s of silence (or 30s total) calls
 * onDone, so a tap to finish is the backup, not the requirement. */
export class Recorder {
  private media: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private watch: number | undefined;
  private capTimer: number | undefined;

  async start(onDone?: () => void): Promise<void> {
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    this.rec = mime ? new MediaRecorder(this.media, { mimeType: mime }) : new MediaRecorder(this.media);
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start();
    if (onDone) this.autoStop(onDone);
  }

  private autoStop(onDone: () => void) {
    let fired = false;
    const done = () => {
      if (fired) return;
      fired = true;
      onDone();
    };
    this.capTimer = window.setTimeout(done, 30000);
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx || !this.media) return;
      this.ctx = new Ctx();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(this.media).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let spoke = false;
      let quietMs = 0;
      this.watch = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        if (rms > 0.02) {
          spoke = true;
          quietMs = 0;
        } else if (spoke) {
          quietMs += 120;
          if (quietMs >= 1600) done();
        }
      }, 120);
    } catch {
      /* no analyser: the 30s cap and tap-to-finish still work */
    }
  }

  /** Stop recording, release the mic, transcribe on the server. */
  async stop(): Promise<string> {
    const rec = this.rec;
    if (!rec) return "";
    if (rec.state !== "inactive") {
      const done = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.stop();
      await done;
    }
    this.release();
    const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
    if (blob.size < 1200) return ""; // a tap with no speech
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio: await blobToB64(blob), mime: blob.type }),
    });
    if (!res.ok) {
      if (res.status === 503) available = false;
      throw new Error(String(res.status));
    }
    const out = (await res.json()) as { text?: string };
    return (out.text ?? "").trim();
  }

  /** Abandon the recording and release the mic. */
  cancel() {
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {
      /* already stopped */
    }
    this.release();
  }

  private release() {
    window.clearInterval(this.watch);
    window.clearTimeout(this.capTimer);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.media?.getTracks().forEach((t) => t.stop());
    this.media = null;
  }
}
