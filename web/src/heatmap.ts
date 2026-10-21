import { z } from "zod";
import { ApiError } from "./habits";
import { heatmapSchema, type Heatmap } from "./heatmap.schema";

export type HeatmapAnchor = { deviceToday: string; timeZone: string };
const problemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
  traceId: z.string().optional(),
});

export function heatmapApi(
  getToken: () => Promise<string | null>,
): (anchor: HeatmapAnchor) => Promise<Heatmap> {
  return async (anchor) => {
    const token = await getToken();
    if (!token) throw new ApiError("Sign in to continue.", 401);
    const query = new URLSearchParams(anchor);
    const response = await fetch(`/api/heatmaps?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("The service returned an unexpected response.", 502);
    }
    if (!response.ok) {
      const problem = problemSchema.safeParse(data);
      if (response.status === 401)
        throw new ApiError(
          "Sign in to continue.",
          401,
          problem.success ? problem.data.traceId : undefined,
        );
      if (!problem.success)
        throw new ApiError(
          "The request could not be completed.",
          response.status,
        );
      const message =
        Object.values(problem.data.errors ?? {})
          .flat()
          .join(" ") ||
        problem.data.detail ||
        problem.data.title;
      throw new ApiError(message, response.status, problem.data.traceId);
    }
    const parsed = heatmapSchema.safeParse(data);
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0] !==
        "application/json" ||
      !parsed.success ||
      parsed.data.end !== anchor.deviceToday
    )
      throw new ApiError("The service returned an unexpected response.", 502);
    return parsed.data;
  };
}
