import { z } from "zod";

/**
 * `POST /api/v1/internal/agency/enable-test-org` (L48, D556): the token's test organisation is now an internal test
 * agency (`internal` and the `agency` add-on on, kind agency). No request body. `changed` is false when it already was.
 */
export const EnableTestAgencyResponse = z.strictObject({
  org_id: z.uuid(),
  changed: z.boolean(),
});
export type EnableTestAgencyResponse = z.infer<typeof EnableTestAgencyResponse>;
