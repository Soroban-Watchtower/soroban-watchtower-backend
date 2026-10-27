import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../observability/logger.js';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  invalidParams?: Array<{ field: string; message: string }>;
  timestamp: string;
}

/**
 * Centralized Fastify error handler conforming to RFC 7807 Problem Details.
 */
export function handleFastifyError(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const instance = request.url;
  const timestamp = new Date().toISOString();

  // 1. Zod Validation Errors
  if (error instanceof ZodError) {
    const invalidParams = error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));

    const response: ProblemDetails = {
      type: 'https://soroban-watchdog.io/errors/validation-error',
      title: 'Invalid Request Payload or Parameters',
      status: 400,
      detail: 'One or more fields failed validation checks.',
      instance,
      invalidParams,
      timestamp,
    };

    reply.status(400).header('Content-Type', 'application/problem+json').send(response);
    return;
  }

  // 2. Fastify Schema Validation Errors
  if ((error as any).validation) {
    const invalidParams = (error as any).validation.map((v: any) => ({
      field: v.instancePath || v.params?.missingProperty || 'field',
      message: v.message || 'validation failed',
    }));

    const response: ProblemDetails = {
      type: 'https://soroban-watchdog.io/errors/validation-error',
      title: 'Schema Validation Error',
      status: 400,
      detail: error.message,
      instance,
      invalidParams,
      timestamp,
    };

    reply.status(400).header('Content-Type', 'application/problem+json').send(response);
    return;
  }

  // 3. Prisma Record Not Found (P2025)
  if ((error as any).code === 'P2025') {
    const response: ProblemDetails = {
      type: 'https://soroban-watchdog.io/errors/resource-not-found',
      title: 'Resource Not Found',
      status: 404,
      detail: 'The requested resource does not exist.',
      instance,
      timestamp,
    };

    reply.status(404).header('Content-Type', 'application/problem+json').send(response);
    return;
  }

  // 4. Prisma Unique Constraint Violation (P2002)
  if ((error as any).code === 'P2002') {
    const fields = (error as any).meta?.target || [];
    const response: ProblemDetails = {
      type: 'https://soroban-watchdog.io/errors/conflict',
      title: 'Unique Constraint Violation',
      status: 409,
      detail: `A record with matching unique fields already exists: ${fields.join(', ')}`,
      instance,
      timestamp,
    };

    reply.status(409).header('Content-Type', 'application/problem+json').send(response);
    return;
  }

  // 5. Prisma Foreign Key Constraint (P2003)
  if ((error as any).code === 'P2003') {
    const field = (error as any).meta?.field_name || 'referenced resource';
    const response: ProblemDetails = {
      type: 'https://soroban-watchdog.io/errors/invalid-reference',
      title: 'Invalid Foreign Key Reference',
      status: 400,
      detail: `The referenced entity does not exist (${field}).`,
      instance,
      timestamp,
    };

    reply.status(400).header('Content-Type', 'application/problem+json').send(response);
    return;
  }

  // 6. Default Internal Server Error
  const statusCode = (error as any).statusCode && (error as any).statusCode >= 400 ? (error as any).statusCode : 500;

  logger.error(
    {
      err: error,
      url: request.url,
      method: request.method,
      requestId: request.requestId,
    },
    `[ErrorHandler] Unhandled error: ${error.message}`
  );

  const response: ProblemDetails = {
    type: 'https://soroban-watchdog.io/errors/internal-server-error',
    title: statusCode === 404 ? 'Not Found' : 'Internal Server Error',
    status: statusCode,
    detail: statusCode === 500 ? 'An unexpected server error occurred.' : error.message,
    instance,
    timestamp,
  };

  reply.status(statusCode).header('Content-Type', 'application/problem+json').send(response);
}
