import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export function errorHandler(
  error: Error & { statusCode?: number; validation?: unknown },
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Check if it's a known AppError
  if (error instanceof AppError) {
    logger.warn({
      msg: 'Application warning',
      err: {
        message: error.message,
        statusCode: error.statusCode,
        details: error.details,
      },
      url: request.url,
      method: request.method,
    });

    return reply.status(error.statusCode).send({
      success: false,
      error: {
        message: error.message,
        statusCode: error.statusCode,
        details: error.details,
      },
    });
  }

  // Handle Fastify built-in schema validation errors
  if (error.validation) {
    logger.warn({
      msg: 'Validation warning',
      err: error.validation,
      url: request.url,
      method: request.method,
    });

    return reply.status(400).send({
      success: false,
      error: {
        message: 'Validation failed',
        statusCode: 400,
        details: error.validation,
      },
    });
  }

  // Generic internal server error
  logger.error({
    msg: 'Unhandled internal server error',
    err: {
      message: error.message,
      stack: error.stack,
    },
    url: request.url,
    method: request.method,
  });

  return reply.status(error.statusCode || 500).send({
    success: false,
    error: {
      message: 'Internal server error',
      statusCode: error.statusCode || 500,
    },
  });
}
