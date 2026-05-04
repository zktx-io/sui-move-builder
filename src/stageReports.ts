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
