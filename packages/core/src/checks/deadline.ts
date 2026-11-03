/** Thrown by the recognisers and parsers when the check's deadline passes mid-file; run.ts maps it to `error`. */
export class DeadlineExceeded extends Error {
  constructor() {
    super("check deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

export type OverDeadline = () => boolean;
export const NO_DEADLINE: OverDeadline = () => false;
