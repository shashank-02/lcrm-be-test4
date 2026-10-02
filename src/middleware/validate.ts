import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { validationError } from '../common/errors';

type Part = 'body' | 'query' | 'params';

/** Validates and *replaces* req[part] with the parsed (coerced, defaulted) value. */
export function validate(schemas: Partial<Record<Part, ZodTypeAny>>): RequestHandler {
  return (req, _res, next) => {
    for (const part of Object.keys(schemas) as Part[]) {
      const schema = schemas[part]!;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        return next(
          validationError(
            result.error.issues.map((i) => ({ path: [part, ...i.path].join('.'), message: i.message })),
          ),
        );
      }
      (req as unknown as Record<Part, unknown>)[part] = result.data;
    }
    next();
  };
}
