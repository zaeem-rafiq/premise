// A `.wasm` import in the Worker bundle. Wrangler bundles it as a compiled module, and the
// Workers runtime hands it over as a `WebAssembly.Module`: a Worker may not compile WebAssembly
// from bytes at run time (https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/).

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
