/** `GET /client`: the CLI's update check (docs/25 §Client, docs/15 §Updates). */
import { z } from "zod";

const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

export const ClientResponse = z.object({ latest: Version, min_supported: Version, package: z.string() });
export type ClientResponse = z.infer<typeof ClientResponse>;

/** Compares two `x.y.z[-pre]` versions: negative when a < b. Pre-releases sort before their release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
