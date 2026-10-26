// Just enough of the Capacitor plugins' types to build the SDK without installing Capacitor here (they are peer
// dependencies). Apps typecheck against the real packages.
declare module "@capacitor/core" {
  export const Capacitor: { getPlatform(): string; DEBUG?: boolean };
  export const CapacitorHttp: {
    request(options: { url: string; method: string; headers?: Record<string, string>; data?: unknown; connectTimeout?: number; readTimeout?: number }): Promise<{ status: number; headers: Record<string, string>; data: unknown }>;
  };
}
declare module "@capacitor/app" {
  type Handle = { remove(): Promise<void> | void };
  export const App: {
    getInfo(): Promise<{ name: string; id: string; build: string; version: string }>;
    getState(): Promise<{ isActive: boolean }>;
    getLaunchUrl(): Promise<{ url: string } | undefined>;
    addListener(event: "pause" | "resume", fn: () => void): Promise<Handle>;
  };
}
declare module "@capacitor/device" {
  export const Device: {
    getInfo(): Promise<{ model: string; platform: "ios" | "android" | "web"; osVersion: string; androidSDKVersion?: number; isVirtual: boolean }>;
    getLanguageTag(): Promise<{ value: string }>;
  };
}
declare module "@capacitor/preferences" {
  export const Preferences: {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
  };
}
