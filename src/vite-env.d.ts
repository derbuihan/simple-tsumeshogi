/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 問題データ（mate{N}/NNN.txt）の配信元 URL。末尾は "/" */
  readonly VITE_PROBLEMS_BASE?: string;
}
