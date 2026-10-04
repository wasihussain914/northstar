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

/** One tap-to-talk session: start() to record, stop() to get the transcript. */
export class Recorder {
  private media: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async start(): Promise<void> {
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    this.rec = mime ? new MediaRecorder(this.media, { mimeType: mime }) : new MediaRecorder(this.media);
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start();
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
    this.media?.getTracks().forEach((t) => t.stop());
    this.media = null;
  }
}
