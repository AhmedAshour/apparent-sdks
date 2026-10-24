const m = new Map();
export default {
  getItem: async (k) => m.get(k) ?? null,
  setItem: async (k, v) => { m.set(k, v); },
};
