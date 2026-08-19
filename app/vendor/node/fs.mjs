// minimal browser shim for node:fs (unused in BYOK browser path)
const dead = (n) => () => { throw new Error("node:fs." + n + " not available in browser"); };
export default new Proxy({}, { get: (_, k) => dead(String(k)) });
export const readFileSync = dead("readFileSync");
export const existsSync = () => false;
export const promises = new Proxy({}, { get: (_, k) => dead(String(k)) });
