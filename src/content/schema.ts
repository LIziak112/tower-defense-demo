import { z } from 'zod';

export const ConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  map: z.object({
    width: z.number().int().min(5).max(30),
    height: z.number().int().min(5).max(30),
    path: z.array(
      z.object({ x: z.number().int(), y: z.number().int() })
    ).min(2)
  }),
  towers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      cost: z.number().int().min(10).max(1000),
      damage: z.number().min(1).max(500),
      range: z.number().min(1).max(10),
      cooldown: z.number().min(1).max(100)
    })
  ).min(1),
  waves: z.array(
    z.object({
      count: z.number().int().min(1).max(100),
      interval: z.number().int().min(10).max(300),
      enemyHp: z.number().min(1).max(10000),
      enemySpeed: z.number().min(0.1).max(5)
    })
  ).min(1)
});

export type GameConfig = z.infer<typeof ConfigSchema>;

export function validateConfig(data: unknown): { success: true, data: GameConfig } | { success: false, errors: string[] } {
  const result = ConfigSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return {
      success: false,
      errors: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    };
  }
}
