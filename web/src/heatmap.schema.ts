import { z } from "zod";

const heatmapDateSchema = z
  .object({
    date: z.iso.date(),
    scheduledCount: z.number().int().nonnegative(),
    earnedPoints: z.number().int().nonnegative(),
    maximumPoints: z.number().int().nonnegative(),
    completion: z.number().min(0).max(1).nullable(),
  })
  .refine((day) => {
    if (day.maximumPoints !== day.scheduledCount * 3) return false;
    if (day.earnedPoints > day.maximumPoints) return false;
    if (day.maximumPoints === 0)
      return day.completion === null && day.earnedPoints === 0;
    return day.completion === day.earnedPoints / day.maximumPoints;
  }, "Daily totals must agree.");

export const heatmapSchema = z
  .object({
    start: z.iso.date(),
    end: z.iso.date(),
    days: z.array(heatmapDateSchema).length(365),
  })
  .refine((heatmap) => {
    const start = new Date(`${heatmap.start}T00:00:00Z`);
    return heatmap.days.every((day, index) => {
      const expected = new Date(start);
      expected.setUTCDate(expected.getUTCDate() + index);
      return (
        day.date === expected.toISOString().slice(0, 10) &&
        (index !== 364 || day.date === heatmap.end)
      );
    });
  }, "The heatmap must contain 365 consecutive dates.");

export type Heatmap = z.infer<typeof heatmapSchema>;
export type HeatmapDate = Heatmap["days"][number];
