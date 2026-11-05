import { CloseCode, parseServerMessage, type ClientMessage } from "../../../server/src/protocol";

const TIMEOUT_MS = 5000;

export type RoomVideoAnswer =
  { status: "ok"; sealed: string | null } | { status: "gone" } | { status: "unreachable" };

type RoomVideoRequest = Extract<ClientMessage, { type: "video/get" | "video/set" }>;

/**
 * A brief visit to the room, without joining it. The popup does this itself because a tab
 * on a new tab page or the like has no content script to ask.
 */
export function askRoomVideo(url: string, request: RoomVideoRequest): Promise<RoomVideoAnswer> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve({ status: "unreachable" });
      return;
    }
    const finish = (answer: RoomVideoAnswer) => {
      clearTimeout(timer);
      resolve(answer);
      socket.close();
    };
    const timer = setTimeout(() => finish({ status: "unreachable" }), TIMEOUT_MS);

    socket.addEventListener("open", () => socket.send(JSON.stringify(request)));
    socket.addEventListener("message", (event) => {
      const message = parseServerMessage(event.data);
      if (message?.type === "video") finish({ status: "ok", sealed: message.sealed });
    });
    socket.addEventListener("close", (event) => {
      finish(
        event.code === CloseCode.RoomNotFound ? { status: "gone" } : { status: "unreachable" },
      );
    });
  });
}
