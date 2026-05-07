export interface MovePackageStageReport {
  stage: string;
  packageId?: string;
  environment: string;
  modes: string[];
  nodeCount?: number;
  edgeCount?: number;
  activeEdgeCount?: number;
  linkedNodeCount?: number;
  code?: string;
}

export interface MovePackageFetchFailedSource {
  type: string;
  git?: string;
  rev?: string;
  subdir?: string;
  local?: string;
  address?: string;
}

export interface MovePackageFetchFailedReport {
  dependencyName: string;
  source: MovePackageFetchFailedSource;
  parentPackageName?: string;
  parentSource?: MovePackageFetchFailedSource;
  error: string;
  code?: string;
}
