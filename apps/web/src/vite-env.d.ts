/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * VAPID public key for Web Push subscription (see apps/web/src/data/push.ts).
   * Not set in this dev environment — actual key generation happens during
   * deployment. Code that reads this must handle it being undefined.
   */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
