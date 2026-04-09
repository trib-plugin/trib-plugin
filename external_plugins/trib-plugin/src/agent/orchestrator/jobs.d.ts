export type JobStatus = 'running' | 'completed' | 'failed';
export interface JobIndex {
    jobId: string;
    sessionId: string;
    status: JobStatus;
    startedAt: string;
    finishedAt?: string;
}
export interface JobDetail {
    jobId: string;
    sessionId: string;
    status: JobStatus;
    request: {
        prompt: string;
        context?: string;
    };
    result?: string;
    startedAt: string;
    finishedAt?: string;
}
export declare function createJob(sessionId: string, prompt: string, context?: string): string;
export declare function completeJob(jobId: string, result: string, failed?: boolean): void;
export declare function getJob(jobId: string): JobDetail | null;
export declare function listJobs(): JobIndex[];
