/** 83 becomes 1:23, and 3723 becomes 1:02:03. Null for anything without a known length. */
/** A playback speed the way players show it, like 1.5x. */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

export function formatTimecode(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
