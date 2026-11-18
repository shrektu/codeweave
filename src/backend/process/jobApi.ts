import type * as KoffiModule from "koffi";

import {
  JOB_PID_LIST_INITIAL_CAPACITY,
  JOB_PID_LIST_MAX_CAPACITY,
} from "../constants";

export type JobHandle = bigint;

export interface JobApi {
  createJob(): JobHandle;
  assignPid(job: JobHandle, pid: number): boolean;
  assignSelf(job: JobHandle): void;
  pids(job: JobHandle): number[];
  terminate(job: JobHandle): void;
  close(job: JobHandle): void;
}

export interface LoadJobApiOptions {
  readonly pidListCapacity?: number;
}

export class JobApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobApiError";
  }
}

type Koffi = typeof KoffiModule;
type NativeCall = (...args: unknown[]) => unknown;

interface Kernel32 {
  readonly createJobObject: NativeCall;
  readonly setInformationJobObject: NativeCall;
  readonly queryInformationJobObject: NativeCall;
  readonly assignProcessToJobObject: NativeCall;
  readonly terminateJobObject: NativeCall;
  readonly getCurrentProcess: NativeCall;
  readonly openProcess: NativeCall;
  readonly closeHandle: NativeCall;
}

const KERNEL32_LIBRARY = "kernel32.dll";
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_PID_LIST_INFORMATION_CLASS = 3;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const JOB_TERMINATE_EXIT_CODE = 1;
const PID_LIST_ASSIGNED_OFFSET = 0;
const PID_LIST_LISTED_OFFSET = 4;
const PID_LIST_GROWTH_FACTOR = 2;
const PID_LIST_MIN_CAPACITY = 1;
const PID_LIST_HEADER_BYTES = 8;
const PID_LIST_ENTRY_BYTES = 8;
const HANDLE_TYPE = "HANDLE";
const BASIC_LIMIT_STRUCT = "JOBOBJECT_BASIC_LIMIT_INFORMATION";
const IO_COUNTERS_STRUCT = "IO_COUNTERS";
const EXTENDED_LIMIT_STRUCT = "JOBOBJECT_EXTENDED_LIMIT_INFORMATION";

function decodePids(buffer: Buffer, capacity: number): number[] {
  const listed = Math.min(
    buffer.readUInt32LE(PID_LIST_LISTED_OFFSET),
    capacity,
  );
  return Array.from({ length: listed }, (_, index) =>
    Number(
      buffer.readBigUInt64LE(
        PID_LIST_HEADER_BYTES + index * PID_LIST_ENTRY_BYTES,
      ),
    ),
  );
}

export function readPidList(
  query: (buffer: Buffer) => boolean,
  initialCapacity: number = JOB_PID_LIST_INITIAL_CAPACITY,
): number[] {
  let capacity = Math.min(
    Math.max(initialCapacity, PID_LIST_MIN_CAPACITY),
    JOB_PID_LIST_MAX_CAPACITY,
  );
  for (;;) {
    const buffer = Buffer.alloc(
      PID_LIST_HEADER_BYTES + capacity * PID_LIST_ENTRY_BYTES,
    );
    const complete = query(buffer);
    const assigned = buffer.readUInt32LE(PID_LIST_ASSIGNED_OFFSET);
    if (
      capacity >= JOB_PID_LIST_MAX_CAPACITY ||
      (complete && assigned <= capacity)
    ) {
      return decodePids(buffer, capacity);
    }
    capacity = Math.min(
      Math.max(assigned, capacity * PID_LIST_GROWTH_FACTOR),
      JOB_PID_LIST_MAX_CAPACITY,
    );
  }
}

function requireHandle(value: unknown, call: string): JobHandle {
  if (typeof value === "bigint") {
    return value;
  }
  throw new JobApiError(`${call} returned no handle`);
}

function succeeded(value: unknown): boolean {
  return typeof value === "number" && value !== 0;
}

function requireSuccess(value: unknown, call: string): void {
  if (!succeeded(value)) {
    throw new JobApiError(`${call} failed`);
  }
}

function registerTypes(koffi: Koffi): void {
  koffi.pointer(HANDLE_TYPE, koffi.opaque());
  koffi.struct(BASIC_LIMIT_STRUCT, {
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  koffi.struct(IO_COUNTERS_STRUCT, {
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  koffi.struct(EXTENDED_LIMIT_STRUCT, {
    BasicLimitInformation: BASIC_LIMIT_STRUCT,
    IoInfo: IO_COUNTERS_STRUCT,
    ProcessMemoryLimit: "uintptr_t",
    JobMemoryLimit: "uintptr_t",
    PeakProcessMemoryUsed: "uintptr_t",
    PeakJobMemoryUsed: "uintptr_t",
  });
}

function bindKernel32(koffi: Koffi): Kernel32 {
  const kernel32 = koffi.load(KERNEL32_LIBRARY);
  return {
    createJobObject: kernel32.func(
      "HANDLE CreateJobObjectW(void *attributes, const char16_t *name)",
    ),
    setInformationJobObject: kernel32.func(
      `int SetInformationJobObject(HANDLE job, int infoClass, ${EXTENDED_LIMIT_STRUCT} *info, uint32_t length)`,
    ),
    queryInformationJobObject: kernel32.func(
      "int QueryInformationJobObject(HANDLE job, int infoClass, void *info, uint32_t length, _Out_ uint32_t *returned)",
    ),
    assignProcessToJobObject: kernel32.func(
      "int AssignProcessToJobObject(HANDLE job, HANDLE process)",
    ),
    terminateJobObject: kernel32.func(
      "int TerminateJobObject(HANDLE job, uint32_t exitCode)",
    ),
    getCurrentProcess: kernel32.func("HANDLE GetCurrentProcess()"),
    openProcess: kernel32.func(
      "HANDLE OpenProcess(uint32_t access, int inherit, uint32_t pid)",
    ),
    closeHandle: kernel32.func("int CloseHandle(HANDLE handle)"),
  };
}

function createJobIn(native: Kernel32, limitLength: number): JobHandle {
  const job = requireHandle(
    native.createJobObject(null, null),
    "CreateJobObjectW",
  );
  const configured = native.setInformationJobObject(
    job,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
    {
      BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
    },
    limitLength,
  );
  if (!succeeded(configured)) {
    native.closeHandle(job);
    throw new JobApiError("SetInformationJobObject failed");
  }
  return job;
}

function assignPidIn(native: Kernel32, job: JobHandle, pid: number): boolean {
  const target = native.openProcess(
    PROCESS_TERMINATE | PROCESS_SET_QUOTA,
    0,
    pid,
  );
  if (typeof target !== "bigint") {
    return false;
  }
  try {
    requireSuccess(
      native.assignProcessToJobObject(job, target),
      "AssignProcessToJobObject",
    );
    return true;
  } finally {
    native.closeHandle(target);
  }
}

interface Binding {
  readonly native: Kernel32;
  readonly limitLength: number;
}

let sharedBinding: Promise<Binding> | null = null;

async function importBinding(): Promise<Binding> {
  const koffi = await import("koffi");
  registerTypes(koffi);
  return {
    native: bindKernel32(koffi),
    limitLength: koffi.sizeof(EXTENDED_LIMIT_STRUCT),
  };
}

async function loadBinding(): Promise<Binding> {
  sharedBinding ??= importBinding();
  try {
    return await sharedBinding;
  } catch (error) {
    sharedBinding = null;
    throw error;
  }
}

function createApi(
  { native, limitLength }: Binding,
  pidListCapacity: number,
): JobApi {
  return {
    createJob: () => createJobIn(native, limitLength),
    assignPid: (job, pid) => assignPidIn(native, job, pid),
    assignSelf(job: JobHandle): void {
      requireSuccess(
        native.assignProcessToJobObject(job, native.getCurrentProcess()),
        "AssignProcessToJobObject",
      );
    },
    pids: (job) =>
      readPidList(
        (buffer) =>
          succeeded(
            native.queryInformationJobObject(
              job,
              JOB_OBJECT_PID_LIST_INFORMATION_CLASS,
              buffer,
              buffer.length,
              [0],
            ),
          ),
        pidListCapacity,
      ),
    terminate(job: JobHandle): void {
      requireSuccess(
        native.terminateJobObject(job, JOB_TERMINATE_EXIT_CODE),
        "TerminateJobObject",
      );
    },
    close(job: JobHandle): void {
      requireSuccess(native.closeHandle(job), "CloseHandle");
    },
  };
}

export async function loadJobApi(
  options: LoadJobApiOptions = {},
): Promise<JobApi> {
  try {
    return createApi(
      await loadBinding(),
      options.pidListCapacity ?? JOB_PID_LIST_INITIAL_CAPACITY,
    );
  } catch (error) {
    throw new JobApiError("Win32 job object bindings are unavailable", {
      cause: error,
    });
  }
}
