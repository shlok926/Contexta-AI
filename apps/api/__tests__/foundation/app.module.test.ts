import { Test, TestingModule } from '@nestjs/testing';

describe('AppModule (Foundation)', () => {
  let appModule: TestingModule;
  let AppModuleClass: any;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key-min-10-chars';
    process.env.JWT_VERIFICATION_PROFILE = 'symmetric';
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret-with-at-least-32-chars-long';

    const { AppModule } = await import('../../src/app.module.js');
    AppModuleClass = AppModule;

    appModule = await Test.createTestingModule({
      imports: [AppModuleClass],
    }).compile();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should compile the application module', () => {
    expect(appModule).toBeDefined();
  });

  it('should resolve required foundation modules', () => {
    const app = appModule.get(AppModuleClass);
    expect(app).toBeDefined();
  });
});
