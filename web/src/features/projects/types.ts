export const projectTypes = ['M365Migration', 'PowerOfficeImplementation', 'AteraRollout', 'Other'] as const;
export type ProjectType = (typeof projectTypes)[number];

export const projectStatuses = ['Planned', 'Active', 'OnHold', 'Completed', 'Cancelled'] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectBillingModels = ['Fixed', 'TimeAndMaterial', 'PerPhase'] as const;
export type ProjectBillingModel = (typeof projectBillingModels)[number];

export const phaseStatuses = ['Planned', 'Active', 'Completed', 'Cancelled'] as const;
export type ProjectPhaseStatus = (typeof phaseStatuses)[number];

export const taskStatuses = ['Open', 'InProgress', 'Done', 'Cancelled'] as const;
export type ProjectTaskStatus = (typeof taskStatuses)[number];

export interface Ref {
  id: string;
  name: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  assignee: Ref | null;
  dueDate: string | null;
  estimatedHours: number;
  status: ProjectTaskStatus;
  notes: string | null;
}

export interface ProjectPhase {
  id: string;
  order: number;
  name: string;
  status: ProjectPhaseStatus;
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedHours: number;
  /** Only for users with finance.read. */
  fee?: number;
  billOnCompletion: boolean;
  productId: string | null;
  productName: string | null;
  completedOn: string | null;
  tasks: ProjectTask[];
}

/** Plan against actual: the budget, the hours booked on the project and what they are worth. */
export interface ProjectProgress {
  budgetHours: number;
  hours: number;
  billableHours: number;
  budgetAmount?: number;
  amount?: number;
  phaseFeesCompleted?: number;
  phasesDone: number;
  phases: number;
  openTasks: number;
}

export interface Project {
  id: string;
  number: string;
  name: string;
  organization: Ref;
  type: ProjectType;
  status: ProjectStatus;
  billingModel: ProjectBillingModel;
  manager: Ref | null;
  startDate: string;
  endDate: string | null;
  completedOn: string | null;
  contractId: string | null;
  opportunityId: string | null;
  notes: string | null;
  progress: ProjectProgress;
  phases: ProjectPhase[];
  /** The team (DEV-09): with the manager and the task assignees, the people the project is assigned to. */
  members: Ref[];
  etag: string;
}

export interface ProjectListItem {
  id: string;
  number: string;
  name: string;
  organization: Ref;
  type: ProjectType;
  status: ProjectStatus;
  manager: Ref | null;
  startDate: string;
  endDate: string | null;
  budgetHours: number;
  hours: number;
  phasesDone: number;
  phases: number;
}

export interface ProjectRequest {
  organizationId: string;
  name: string;
  type: ProjectType;
  billingModel: ProjectBillingModel;
  managerId: string | null;
  startDate: string;
  endDate: string | null;
  budgetHours: number;
  /** Omitted for callers without finance.read: the server keeps the stored amount. */
  budgetAmount?: number;
  contractId: string | null;
  opportunityId: string | null;
  notes: string | null;
}

export interface PhaseRequest {
  name: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedHours: number;
  /** Omitted for callers without finance.read: the server keeps the stored fee and billing flag. */
  fee?: number;
  billOnCompletion?: boolean;
  productId: string | null;
}

export interface TaskRequest {
  title: string;
  assigneeId: string | null;
  dueDate: string | null;
  estimatedHours: number;
  notes: string | null;
  status: ProjectTaskStatus | null;
}
