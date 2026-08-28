import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { HealthService } from '../../shared/health.service.js';

export async function healthRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  
  // 1. Liveness Probe: "Is GIA running?"
  fastify.get('/health/live', async (request, reply) => {
    return reply.status(200).send({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  // 2. Readiness Probe: "Can GIA serve traffic?"
  // Asserts database and Redis are functional.
  fastify.get('/health/ready', async (request, reply) => {
    try {
      const report = await HealthService.checkDeepHealth();
      const isReady = report.dependencies.database === 'healthy' && report.dependencies.redis === 'healthy';
      
      if (!isReady) {
        return reply.status(503).send({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          dependencies: {
            database: report.dependencies.database,
            redis: report.dependencies.redis,
          },
        });
      }

      return reply.status(200).send({
        status: 'healthy',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return reply.status(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Readiness check failed',
      });
    }
  });

  // 3. Deep Dependency Health Check: detailed check on databases and external APIs
  const handleDeepHealth = async (request: any, reply: any) => {
    try {
      const report = await HealthService.checkDeepHealth();
      const statusCode = report.status === 'unhealthy' ? 503 : 200;
      return reply.status(statusCode).send(report);
    } catch (err: any) {
      return reply.status(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Dependency check failed',
      });
    }
  };

  fastify.get('/health', handleDeepHealth);
  fastify.get('/health/dependencies', handleDeepHealth);
}
