declare namespace Cloudflare {
  interface Env {
    ROOMS: DurableObjectNamespace<import("./room").Room>;
    CREATION_LIMITERS: DurableObjectNamespace<import("./creation-limiter").CreationLimiter>;
    /** Optional secret for hashing addresses, so a hash can't be reversed by trying them all. */
    IP_HASH_KEY?: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
