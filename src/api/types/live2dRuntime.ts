export interface Live2DRuntimeStatusReport {
  /** Whether Cubism 2.1 core (live2d.min.js) is available and staged. */
  cubism2: boolean;
  /** Whether Cubism 3/4/5 core (live2dcubismcore.min.js) is available and staged. */
  cubism3Plus: boolean;
  /** True when EITHER Cubism 2.1 OR Cubism 3/4/5 is missing. */
  missingAny: boolean;
  /** Whether running in developer mode (repository context). */
  isDev: boolean;
  paths: {
    /** The `.local/live2d` staging directory in the repo. */
    localDir: string;
    /** The `public` runtime seed root. */
    seedRoot?: string;
    /** The persistent runtime root in userData. */
    runtimeRoot?: string;
  };
}

export interface Live2DRuntimeItemConfig {
  family: 'cubism2' | 'cubism3Plus';
  title: string;
  fileName: string;
  description: string;
  targetRelativePath: string;
  downloadUrl: string;
  downloadMirrorUrl?: string;
  officialSiteUrl?: string;
  guideText: string;
}
