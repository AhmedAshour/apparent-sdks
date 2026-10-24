// The parts of react-native-device-info the SDK reads (default export, like the real package).
const state = { version: "3.2.1", build: "321", referrer: "unknown" };
/** Test helper. */
export function __setDeviceInfo(next) { Object.assign(state, next); }
const DeviceInfo = {
  getVersion: () => state.version,
  getBuildNumber: () => state.build,
  getInstallReferrer: async () => state.referrer,
};
export default DeviceInfo;
