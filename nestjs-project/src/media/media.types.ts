export interface ProbeResult {
  durationSeconds: number | null;
  width: number;
  height: number;
  videoCodec: string;
  /** `null` when the file has no audio stream. */
  audioCodec: string | null;
  sizeBytes: number | null;
  /** Full ffprobe output (`format` + `streams`), persisted as `metadata`. */
  raw: FfprobeOutput;
}

export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number } & Record<string, number>;
  [key: string]: unknown;
}

export interface FfprobeOutput {
  format?: { duration?: string; size?: string; [key: string]: unknown };
  streams?: FfprobeStream[];
  [key: string]: unknown;
}
