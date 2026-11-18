import type { JobApi, JobHandle } from "../../src/backend/process/jobApi";

export const JobOp = {
  createJob: "createJob",
  assignPid: "assignPid",
  assignSelf: "assignSelf",
  pids: "pids",
  terminate: "terminate",
  close: "close",
} as const;
export type JobOp = (typeof JobOp)[keyof typeof JobOp];

export interface JobCall {
  readonly op: JobOp;
  readonly job: JobHandle | null;
  readonly pid: number | null;
}

export class FakeJobApi implements JobApi {
  readonly calls: JobCall[] = [];
  createFailure: Error | null = null;
  assignPidFailure: Error | null = null;
  assignSelfFailure: Error | null = null;
  processesExist = true;
  private nextHandle = 1n;
  private readonly members = new Map<JobHandle, Set<number>>();

  createJob(): JobHandle {
    this.calls.push({ op: JobOp.createJob, job: null, pid: null });
    if (this.createFailure !== null) {
      throw this.createFailure;
    }
    const job = this.nextHandle;
    this.nextHandle += 1n;
    this.members.set(job, new Set());
    return job;
  }

  assignPid(job: JobHandle, pid: number): boolean {
    this.calls.push({ op: JobOp.assignPid, job, pid });
    if (this.assignPidFailure !== null) {
      throw this.assignPidFailure;
    }
    if (!this.processesExist) {
      return false;
    }
    this.membersOf(job).add(pid);
    return true;
  }

  assignSelf(job: JobHandle): void {
    this.calls.push({ op: JobOp.assignSelf, job, pid: null });
    if (this.assignSelfFailure !== null) {
      throw this.assignSelfFailure;
    }
  }

  pids(job: JobHandle): number[] {
    this.calls.push({ op: JobOp.pids, job, pid: null });
    return [...this.membersOf(job)];
  }

  terminate(job: JobHandle): void {
    this.calls.push({ op: JobOp.terminate, job, pid: null });
    this.membersOf(job).clear();
  }

  close(job: JobHandle): void {
    this.calls.push({ op: JobOp.close, job, pid: null });
  }

  adopt(job: JobHandle, pid: number): void {
    this.membersOf(job).add(pid);
  }

  exit(job: JobHandle, pid: number): void {
    this.membersOf(job).delete(pid);
  }

  callsOf(op: JobOp): readonly JobCall[] {
    return this.calls.filter((call) => call.op === op);
  }

  private membersOf(job: JobHandle): Set<number> {
    const members = this.members.get(job);
    if (members === undefined) {
      throw new Error(`unknown job handle ${String(job)}`);
    }
    return members;
  }
}
