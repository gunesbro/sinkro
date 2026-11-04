declare namespace Cloudflare {
  interface Env {
    ROOMS: DurableObjectNamespace<import("./room").Room>;
    CREATION_LIMITERS: DurableObjectNamespace<import("./creation-limiter").CreationLimiter>;
  }
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
