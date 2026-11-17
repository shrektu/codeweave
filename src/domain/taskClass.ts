import { z } from "zod";

export const TaskClass = {
  light: "light",
  standard: "standard",
  heavy: "heavy",
} as const;
export type TaskClass = (typeof TaskClass)[keyof typeof TaskClass];

export const TASK_CLASS_ORDER: readonly TaskClass[] = [
  TaskClass.light,
  TaskClass.standard,
  TaskClass.heavy,
];

export const TASK_CLASS_ERROR = `Task class must be one of: ${TASK_CLASS_ORDER.join(", ")}`;

export const TaskClassSchema = z.enum(TaskClass, { error: TASK_CLASS_ERROR });

export function parseTaskClass(value: string): TaskClass | null {
  const result = TaskClassSchema.safeParse(value);
  return result.success ? result.data : null;
}
