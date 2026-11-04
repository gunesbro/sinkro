import { pickBest } from "../content/detection/score";

export const TOP_FRAME_ID = 0;
/** Frames report every few seconds while in a room, so silence this long means it's gone. */
const REPORT_EXPIRES_MS = 12_000;

export type FrameReport = { score: number; at: number };
export type FrameReports = Record<number, FrameReport>;

/**
 * Picks the one frame that runs the room connection and sync engine. The top frame
 * holds the connection while no frame has a video, so the room still works and the
 * connection doesn't move until there's somewhere better for it.
 */
export function chooseFrame(current: number, reports: FrameReports, now: number): number {
  const candidates = Object.entries(reports)
    .filter(([, report]) => now - report.at < REPORT_EXPIRES_MS)
    .map(([frameId, report]) => ({ item: Number(frameId), score: report.score }));
  return pickBest(candidates, current)?.item ?? TOP_FRAME_ID;
}
