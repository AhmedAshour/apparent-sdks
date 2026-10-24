export let nativeApplicationVersion = "1.0.0";
export let nativeBuildVersion = "1";
/** Test helper: pretend the app was updated. */
export function __setVersion(version, build) {
  nativeApplicationVersion = version;
  nativeBuildVersion = build;
}
export let __referrer = "";
/** Test helper: what the Play install referrer returns. */
export function __setReferrer(r) { __referrer = r; }
export async function getInstallReferrerAsync() { return __referrer; }
