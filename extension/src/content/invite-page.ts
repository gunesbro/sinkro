import type { BackgroundRequest } from "../messages";

/**
 * On Sinkro's own invite page: tells the page the extension is here, and joins when the
 * viewer clicks. Only a real click counts, so no script can put someone in a room.
 */
export function connectInvitePage(
  send: (request: BackgroundRequest) => Promise<{ joined: boolean } | null | undefined>,
): void {
  document.documentElement.dataset.sinkro = "installed";
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    if (!(event.target instanceof Element) || !event.target.closest("#join-room")) return;
    void send({ type: "invite/join", fragment: location.hash.slice(1) }).then((result) => {
      // With a video to go to, the tab has already left this page.
      if (result?.joined) document.documentElement.dataset.sinkro = "joined";
    });
  });
}
