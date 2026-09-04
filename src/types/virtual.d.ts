declare module 'virtual:plugin-defaults' {
  const defaults: import('../shared/runtime').PluginDefaults;
  export default defaults;
}

declare module '*.html?vue-template' {
  export const render: import('vue').RenderFunction;
}
