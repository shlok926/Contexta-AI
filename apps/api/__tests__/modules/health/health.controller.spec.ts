import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { HealthModule } from '../../../src/modules/health/health.module.js';
import { HealthController, HealthCheckResponse } from '../../../src/modules/health/controllers/health.controller.js';

describe('HealthController (N5.2)', () => {
  let controller: HealthController;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    controller = moduleRef.get<HealthController>(HealthController);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should be defined with no external dependencies', () => {
    expect(controller).toBeDefined();
    expect(controller).toBeInstanceOf(HealthController);
  });

  it('should return status 200 contract with status ok and valid ISO8601 timestamp', () => {
    const before = new Date().getTime();
    const response: HealthCheckResponse = controller.check();
    const after = new Date().getTime();

    expect(response).toBeDefined();
    expect(response.status).toBe('ok');
    expect(typeof response.timestamp).toBe('string');

    const parsedTime = new Date(response.timestamp).getTime();
    expect(Number.isNaN(parsedTime)).toBe(false);
    expect(parsedTime).toBeGreaterThanOrEqual(before);
    expect(parsedTime).toBeLessThanOrEqual(after);

    // Verify ISO-8601 format
    expect(response.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  it('should have no authentication guards attached (public unauthenticated probe)', () => {
    const classGuards = Reflect.getMetadata(GUARDS_METADATA, HealthController) || [];
    const methodGuards = Reflect.getMetadata(GUARDS_METADATA, HealthController.prototype.check) || [];

    expect(classGuards).toHaveLength(0);
    expect(methodGuards).toHaveLength(0);
  });

  it('should bootstrap HealthModule in NestApplication successfully', () => {
    expect(app).toBeDefined();
    const resolvedController = app.get<HealthController>(HealthController);
    expect(resolvedController).toBeDefined();
    const healthResult = resolvedController.check();
    expect(healthResult.status).toBe('ok');
  });
});
