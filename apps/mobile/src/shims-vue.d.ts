declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare module '*.renderjs.js' {
  const mod: Record<string, unknown>;
  export default mod;
}