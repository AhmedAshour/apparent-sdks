// expo-updates' constants for this launch. Test helper: __setUpdate(id, createdAt, embedded) pretends a new launch.
export let updateId = null;
export let createdAt = null;
export let isEmbeddedLaunch = true;
export function __setUpdate(id, at = null, embedded = false) {
  updateId = id;
  createdAt = at;
  isEmbeddedLaunch = embedded;
}
