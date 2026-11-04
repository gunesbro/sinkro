declare namespace Cloudflare {
  interface Env {
    ROOMS: DurableObjectNamespace<import("./room").Room>;
  }
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
