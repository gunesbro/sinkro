declare namespace Cloudflare {
  interface Env {
    ROOMS: DurableObjectNamespace<import("./room").Room>;
    CREATE_ROOM_LIMIT: RateLimit;
  }
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
