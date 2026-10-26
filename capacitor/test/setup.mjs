// Test setup for the Capacitor SDK: point its @capacitor/* imports at small fakes (mocks/capacitor.mjs), and let
// extensionless relative imports ("./index") resolve to .ts like a bundler does.
import { registerHooks } from "node:module";

const fake = new URL("./mocks/capacitor.mjs", import.meta.url).href;
const plugins = new Set(["@capacitor/core", "@capacitor/app", "@capacitor/device", "@capacitor/preferences"]);

registerHooks({
  resolve(specifier, context, next) {
    if (plugins.has(specifier)) return { url: fake, shortCircuit: true };
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
      try { return next(`${specifier}.ts`, context); } catch { /* not a .ts file */ }
    }
    return next(specifier, context);
  },
});
