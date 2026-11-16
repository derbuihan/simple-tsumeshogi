// Vite が Worker のコードでも置き換える import.meta.env のうち使うもの
interface ImportMetaEnv {
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
