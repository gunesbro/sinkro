const CHECK_INTERVAL_MS = 1000;

function largestVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const video of document.querySelectorAll("video")) {
    const { width, height } = video.getBoundingClientRect();
    if (width * height > bestArea) {
      best = video;
      bestArea = width * height;
    }
  }
  return best;
}

/**
 * Placeholder until the detection engine: follows the largest video in this document.
 * It doesn't see shadow roots or frames and has no scoring. Returns a stop function.
 */
export function watchLargestVideo(onChange: (video: HTMLVideoElement | null) => void): () => void {
  let current: HTMLVideoElement | null = null;
  const check = () => {
    const next = largestVideo();
    if (next !== current) {
      current = next;
      onChange(next);
    }
  };
  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
