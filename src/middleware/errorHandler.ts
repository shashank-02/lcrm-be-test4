import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../common/errors';
import { logger } from '../config/logger';
import { isProd } from '../config/env';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
    });
  }

  // Mongo duplicate key
  if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
    const field = Object.keys(keyValue).filter((k) => k !== 'orgId').join(', ') || 'value';
    return res.status(409).json({
      success: false,
      error: { code: 'DUPLICATE', message: `A record with this ${field} already exists`, details: keyValue },
    });
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(422).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: err.message, details: Object.keys(err.errors) },
    });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: `Invalid ${err.path}` } });
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }

  logger.error({ err, url: req.originalUrl, requestId: req.requestId }, 'Unhandled error');
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL', message: isProd ? 'Something went wrong' : String((err as Error)?.message ?? err) },
  });
};
