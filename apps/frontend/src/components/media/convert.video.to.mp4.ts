// iPhone Safari hands videos to file inputs as QuickTime (.mov /
// video/quicktime), while the rest of the upload pipeline only accepts and
// publishes MP4. Without a server-side normalizer we convert in the browser:
// H.264/AAC MOV is remuxed losslessly, anything else (typically iPhone HEVC)
// is transcoded to H.264/AAC via WebCodecs.
export const MAX_VIDEO_CONVERSION_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

export type VideoConversionErrorReason = 'too_large' | 'unsupported';

export class VideoConversionError extends Error {
  constructor(
    message: string,
    public readonly reason: VideoConversionErrorReason
  ) {
    super(message);
    this.name = 'VideoConversionError';
  }
}

export function isQuickTimeVideo(file: {
  name?: string;
  type?: string;
}): boolean {
  return file.type === 'video/quicktime' || /\.mov$/i.test(file.name ?? '');
}

export async function convertVideoToMp4(
  file: Blob,
  fileName: string,
  onProgress?: (progress: number) => void
): Promise<File> {
  if (file.size > MAX_VIDEO_CONVERSION_SIZE_BYTES) {
    throw new VideoConversionError(
      'This video is too large to convert in the browser. Please trim it or export it as MP4.',
      'too_large'
    );
  }

  // Loaded on demand: the media toolkit is only needed when a MOV is selected
  const {
    Input,
    Output,
    Mp4OutputFormat,
    BufferTarget,
    BlobSource,
    ALL_FORMATS,
    Conversion,
  } = await import('mediabunny');

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  const output = new Output({
    // Fast Start without buffering the whole payload in memory
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target: new BufferTarget(),
  });

  const conversion = await Conversion.init({
    input,
    output,
    // Platforms expect H.264/AAC; matching sources are still copied, HEVC and
    // other codecs are transcoded
    video: { codec: 'avc', hardwareAcceleration: 'prefer-hardware' },
    audio: { codec: 'aac' },
    showWarnings: false,
  });

  if (
    !conversion.isValid ||
    !conversion.utilizedTracks.some((track) => track.isVideoTrack())
  ) {
    throw new VideoConversionError(
      'This video could not be converted to MP4. Please try exporting it as MP4.',
      'unsupported'
    );
  }

  conversion.onProgress = (progress) => onProgress?.(progress);
  await conversion.execute();

  const buffer = output.target.buffer;
  if (!buffer) {
    throw new VideoConversionError(
      'This video could not be converted to MP4. Please try exporting it as MP4.',
      'unsupported'
    );
  }

  const name = fileName.replace(/\.[^.]+$/, '') + '.mp4';
  return new File([buffer], name, {
    type: 'video/mp4',
    lastModified: Date.now(),
  });
}
