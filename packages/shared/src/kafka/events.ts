export type JobEventType =
  | "job.viewed"
  | "job.applied"
  | "application.status_changed";

export interface JobViewedEvent {
  type: "job.viewed";
  job_id: number;
  viewer_id?: number;
  viewed_at: string;
}

export interface JobAppliedEvent {
  type: "job.applied";
  job_id: number;
  applicant_id: number;
  applied_at: string;
}

export interface ApplicationStatusChangedEvent {
  type: "application.status_changed";
  job_id: number;
  application_id: number;
  new_status: string;
  timestamp: string;
}

export type JobEvent =
  | JobViewedEvent
  | JobAppliedEvent
  | ApplicationStatusChangedEvent;
